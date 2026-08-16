"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATABASE_DIR = path.join(ROOT, "src", "database");
const BACKUPS_DIR = path.join(DATABASE_DIR, "backups", "pokedex");
const POKEMON_DIR = path.join(DATABASE_DIR, "pokemon");
const PROPOSED_MANIFEST = path.join(POKEMON_DIR, "manifest.proposed.json");
const ACTIVE_MANIFEST = path.join(POKEMON_DIR, "manifest.json");
const FILES = Array.from({ length: 9 }, (_, index) => `pokedex_gen${index + 1}.json`);
const RANGES = [
  [1, 151], [152, 251], [252, 386], [387, 493], [494, 649],
  [650, 721], [722, 809], [810, 905], [906, 1025]
];

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashesAt(directory) {
  return Object.fromEntries(FILES.map((file) => [file, hashFile(path.join(directory, file))]));
}

function sameHashes(left, right) {
  return FILES.every((file) => left[file] && left[file] === right[file]);
}

function validateBackup(directory, expectedHashes) {
  const missing = FILES.filter((file) => !fs.existsSync(path.join(directory, file)));
  if (missing.length) return { valid: false, error: `Arquivos ausentes: ${missing.join(", ")}` };
  const actualHashes = hashesAt(directory);
  if (!sameHashes(actualHashes, expectedHashes)) return { valid: false, error: "Checksums do backup não conferem." };
  return { valid: true, checkedAt: new Date().toISOString(), checksums: actualHashes };
}

function findIdenticalBackup(sourceHashes) {
  if (!fs.existsSync(BACKUPS_DIR)) return null;
  for (const entry of fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(BACKUPS_DIR, entry.name);
    const manifestPath = path.join(directory, "backup-manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const declared = Object.fromEntries(
        Object.entries(manifest.checksums || {}).map(([file, value]) => [file, typeof value === "string" ? value : value.value])
      );
      if (sameHashes(declared, sourceHashes) && validateBackup(directory, sourceHashes).valid) return directory;
    } catch (_) {
      // Um backup ilegível não é reutilizado, mas também não é apagado.
    }
  }
  return null;
}

function createOrReuseBackup() {
  const sourceHashes = hashesAt(DATABASE_DIR);
  const existing = findIdenticalBackup(sourceHashes);
  if (existing) return { directory: existing, reused: true, checksums: sourceHashes };

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(BACKUPS_DIR, timestamp);
  fs.mkdirSync(directory, { recursive: false });

  try {
    for (const file of FILES) fs.copyFileSync(path.join(DATABASE_DIR, file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
    const validation = validateBackup(directory, sourceHashes);
    if (!validation.valid) throw new Error(validation.error);
    let previousVersion = "unversioned";
    if (fs.existsSync(ACTIVE_MANIFEST)) previousVersion = JSON.parse(fs.readFileSync(ACTIVE_MANIFEST, "utf8")).datasetVersion || previousVersion;
    else if (fs.existsSync(PROPOSED_MANIFEST)) previousVersion = JSON.parse(fs.readFileSync(PROPOSED_MANIFEST, "utf8")).datasetVersion || previousVersion;
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      previousDatasetVersion: previousVersion,
      sourceDirectory: "src/database",
      files: FILES,
      checksums: Object.fromEntries(FILES.map((file) => [file, { algorithm: "sha256", value: sourceHashes[file] }])),
      validation: { status: "valid", ...validation },
      restoration: { possible: true, instruction: "Restaurar os nove arquivos somente após parar o processo e validar novamente estes checksums." }
    };
    fs.writeFileSync(path.join(directory, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { directory, reused: false, checksums: sourceHashes };
  } catch (error) {
    throw new Error(`Backup não pôde ser criado e validado; migração interrompida: ${error.message}`);
  }
}

function loadGenerations(directory = DATABASE_DIR) {
  return FILES.map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
}

function validateGenerations(generations) {
  const errors = [];
  const numbers = [];
  generations.forEach((records, generationIndex) => {
    if (!Array.isArray(records)) {
      errors.push(`${FILES[generationIndex]} não contém array.`);
      return;
    }
    const [min, max] = RANGES[generationIndex];
    records.forEach((record, index) => {
      if (!record || !Number.isInteger(record.numero)) errors.push(`${FILES[generationIndex]}[${index}] sem número inteiro.`);
      else {
        numbers.push(record.numero);
        if (record.numero < min || record.numero > max) errors.push(`${record.numero} fora do limite de ${FILES[generationIndex]}.`);
        if (index && records[index - 1].numero >= record.numero) errors.push(`${FILES[generationIndex]} não está estritamente ordenado no índice ${index}.`);
      }
    });
  });
  if (numbers.length !== 980) errors.push(`Contagem alterada: ${numbers.length}, esperado 980.`);
  if (new Set(numbers).size !== 980) errors.push(`Números únicos: ${new Set(numbers).size}, esperado 980.`);
  return { valid: errors.length === 0, errors, recordCount: numbers.length, uniqueNumberCount: new Set(numbers).size };
}

function moveRange(source, target, min, max) {
  const moving = source.filter((record) => record.numero >= min && record.numero <= max);
  if (moving.length !== max - min + 1) throw new Error(`Faixa ${min}–${max} incompleta: ${moving.length} registros.`);
  if (target.some((record) => record.numero >= min && record.numero <= max)) throw new Error(`Destino já contém registros da faixa ${min}–${max}.`);
  return {
    source: source.filter((record) => record.numero < min || record.numero > max).sort((a, b) => a.numero - b.numero),
    target: [...target, ...moving].sort((a, b) => a.numero - b.numero),
    moved: moving.length
  };
}

function serializeRecords(records) {
  const inlineArray = (values) => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const serialized = records.map((record) => [
    "  {",
    `    "numero": ${JSON.stringify(record.numero)},`,
    `    "nome": ${JSON.stringify(record.nome)},`,
    `    "tipo": ${inlineArray(record.tipo)},`,
    `    "fraquezas": ${inlineArray(record.fraquezas)},`,
    `    "descricao": ${JSON.stringify(record.descricao)}`,
    "  }"
  ].join("\n"));
  return `[\n${serialized.join(",\n")}\n]\n`;
}

function atomicReplaceGenerations(generations, backupDirectory) {
  const temporaryFiles = [];
  const changedIndexes = [2, 3, 7, 8];
  try {
    for (const index of changedIndexes) {
      const target = path.join(DATABASE_DIR, FILES[index]);
      const temporary = `${target}.stage1b-${process.pid}.tmp`;
      fs.writeFileSync(temporary, serializeRecords(generations[index]), "utf8");
      JSON.parse(fs.readFileSync(temporary, "utf8"));
      temporaryFiles.push({ target, temporary, file: FILES[index] });
    }
    for (const entry of temporaryFiles) fs.renameSync(entry.temporary, entry.target);
  } catch (error) {
    for (const entry of temporaryFiles) if (fs.existsSync(entry.temporary)) fs.unlinkSync(entry.temporary);
    for (const index of changedIndexes) fs.copyFileSync(path.join(backupDirectory, FILES[index]), path.join(DATABASE_DIR, FILES[index]));
    throw new Error(`Falha na substituição; arquivos restaurados do backup: ${error.message}`);
  }
}

function duplicateNameProblems(generations) {
  const names = new Map();
  for (const record of generations.flat()) {
    const key = String(record.nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(record);
  }
  return [...names.entries()].filter(([, records]) => records.length > 1).map(([normalizedName, records]) => ({
    normalizedName,
    name: records[0].nome,
    numbers: records.map((record) => record.numero).sort((a, b) => a - b)
  }));
}

function writeActiveManifest(generations, backup, postValidation) {
  const present = new Set(generations.flat().map((record) => record.numero));
  const missingNumbers = Array.from({ length: 1025 }, (_, index) => index + 1).filter((number) => !present.has(number));
  const duplicateNames = duplicateNameProblems(generations);
  const blockedPokemonNumbers = [...new Set(duplicateNames.flatMap((problem) => problem.numbers))].sort((a, b) => a - b);
  const checksums = hashesAt(DATABASE_DIR);
  const manifest = {
    schemaVersion: 1,
    datasetVersion: `1b-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    generations: FILES.map((file, index) => ({ generation: index + 1, min: RANGES[index][0], max: RANGES[index][1], file })),
    pokemonCount: postValidation.recordCount,
    pokemonCountExpected: 1025,
    missingNumbers,
    duplicateNames,
    blockedPokemonNumbers,
    checksums: Object.fromEntries(FILES.map((file) => [file, { algorithm: "sha256", value: checksums[file] }])),
    lastUpdatedAt: new Date().toISOString(),
    status: "partial_validated",
    backupUsed: path.relative(ROOT, backup.directory).replace(/\\/g, "/"),
    backupReused: backup.reused
  };
  fs.mkdirSync(POKEMON_DIR, { recursive: true });
  const temporary = `${ACTIVE_MANIFEST}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(temporary, "utf8"));
  fs.renameSync(temporary, ACTIVE_MANIFEST);
  return manifest;
}

function migrate() {
  const backup = createOrReuseBackup();
  const generations = loadGenerations();
  const beforeCount = generations.flat().length;
  const gen3Move = moveRange(generations[3], generations[2], 353, 386);
  generations[3] = gen3Move.source;
  generations[2] = gen3Move.target;
  const gen8Move = moveRange(generations[8], generations[7], 899, 905);
  generations[8] = gen8Move.source;
  generations[7] = gen8Move.target;
  const validation = validateGenerations(generations);
  if (!validation.valid) throw new Error(`Validação prévia falhou; nenhum arquivo foi alterado: ${validation.errors.join(" ")}`);
  if (generations.flat().length !== beforeCount) throw new Error("A movimentação alteraria a quantidade total; migração interrompida.");
  atomicReplaceGenerations(generations, backup.directory);
  const persisted = loadGenerations();
  const persistedValidation = validateGenerations(persisted);
  if (!persistedValidation.valid) {
    for (const file of FILES) fs.copyFileSync(path.join(backup.directory, file), path.join(DATABASE_DIR, file));
    throw new Error(`Validação posterior falhou; backup restaurado: ${persistedValidation.errors.join(" ")}`);
  }
  const manifest = writeActiveManifest(persisted, backup, persistedValidation);
  return { backup, moved353to386: gen3Move.moved, moved899to905: gen8Move.moved, validation: persistedValidation, manifest };
}

function formatCurrentCorrectedFiles() {
  const generations = loadGenerations();
  const validation = validateGenerations(generations);
  if (!validation.valid) throw new Error(`Formatação recusada: ${validation.errors.join(" ")}`);
  for (const index of [2, 3, 7, 8]) {
    const target = path.join(DATABASE_DIR, FILES[index]);
    const temporary = `${target}.format-${process.pid}.tmp`;
    fs.writeFileSync(temporary, serializeRecords(generations[index]), "utf8");
    JSON.parse(fs.readFileSync(temporary, "utf8"));
    fs.renameSync(temporary, target);
  }
  const manifest = JSON.parse(fs.readFileSync(ACTIVE_MANIFEST, "utf8"));
  const checksums = hashesAt(DATABASE_DIR);
  manifest.checksums = Object.fromEntries(FILES.map((file) => [file, { algorithm: "sha256", value: checksums[file] }]));
  manifest.lastUpdatedAt = new Date().toISOString();
  const manifestTemporary = `${ACTIVE_MANIFEST}.format-${process.pid}.tmp`;
  fs.writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(manifestTemporary, ACTIVE_MANIFEST);
  return validation;
}

if (require.main === module) {
  if (process.argv.includes("--format-current")) {
    const validation = formatCurrentCorrectedFiles();
    console.log(`Formatação estrutural validada: ${validation.recordCount} registros.`);
  } else {
    const result = migrate();
    console.log(`Backup ${result.backup.reused ? "reutilizado" : "criado"}: ${path.relative(ROOT, result.backup.directory)}`);
    console.log(`Movidos: ${result.moved353to386} (353–386) e ${result.moved899to905} (899–905).`);
    console.log(`Validação: ${result.validation.recordCount} registros, ${result.validation.uniqueNumberCount} números únicos.`);
  }
}

module.exports = { createOrReuseBackup, formatCurrentCorrectedFiles, hashesAt, loadGenerations, migrate, moveRange, sameHashes, validateBackup, validateGenerations };

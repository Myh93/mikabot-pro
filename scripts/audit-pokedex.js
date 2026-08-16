"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATABASE_DIR = path.join(ROOT, "src", "database");
const REPORTS_DIR = path.join(ROOT, "reports");
const MANIFEST_DIR = path.join(DATABASE_DIR, "pokemon");
const EXPECTED_MIN = 1;
const EXPECTED_MAX = 1025;

const GENERATIONS = [
  { generation: 1, min: 1, max: 151, file: "pokedex_gen1.json" },
  { generation: 2, min: 152, max: 251, file: "pokedex_gen2.json" },
  { generation: 3, min: 252, max: 386, file: "pokedex_gen3.json" },
  { generation: 4, min: 387, max: 493, file: "pokedex_gen4.json" },
  { generation: 5, min: 494, max: 649, file: "pokedex_gen5.json" },
  { generation: 6, min: 650, max: 721, file: "pokedex_gen6.json" },
  { generation: 7, min: 722, max: 809, file: "pokedex_gen7.json" },
  { generation: 8, min: 810, max: 905, file: "pokedex_gen8.json" },
  { generation: 9, min: 906, max: 1025, file: "pokedex_gen9.json" }
];

const VALID_TYPES = new Set([
  "Bug", "Dark", "Dragon", "Electric", "Fairy", "Fighting", "Fire",
  "Flying", "Ghost", "Grass", "Ground", "Ice", "Normal", "Poison",
  "Psychic", "Rock", "Steel", "Water"
]);
const EXPECTED_FIELDS = ["numero", "nome", "tipo", "fraquezas", "descricao"];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9♀♂' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generationForNumber(number) {
  return GENERATIONS.find((entry) => number >= entry.min && number <= entry.max) || null;
}

function issueBase(record, suggestion, confidence) {
  return {
    currentFile: record.file,
    currentIndex: record.index,
    currentValues: record.value,
    suggestedCorrection: suggestion,
    confidence
  };
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeTextAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, value, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function loadFiles() {
  const files = [];
  const records = [];

  for (const definition of GENERATIONS) {
    const absolutePath = path.join(DATABASE_DIR, definition.file);
    const raw = fs.readFileSync(absolutePath);
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`JSON inválido em ${definition.file}: ${error.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`${definition.file} deve conter um array na raiz.`);
    }
    files.push({
      file: definition.file,
      path: path.relative(ROOT, absolutePath).replace(/\\/g, "/"),
      generation: definition.generation,
      expectedRange: [definition.min, definition.max],
      recordCount: data.length,
      checksum: sha256(raw)
    });
    data.forEach((value, index) => records.push({
      file: definition.file,
      generation: definition.generation,
      index,
      value
    }));
  }

  return { files, records };
}

function audit() {
  const auditedAt = new Date().toISOString();
  const { files, records } = loadFiles();
  const byNumber = new Map();
  const byName = new Map();
  const issues = {
    missingNumbers: [],
    duplicateNumbers: [],
    duplicateNames: [],
    nameNumberConflicts: [],
    misplacedRecords: [],
    emptyFields: [],
    invalidTypes: [],
    invalidWeaknesses: [],
    descriptionsRevealName: [],
    formatDifferences: [],
    incorrectOrder: []
  };

  for (const record of records) {
    const value = record.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.formatDifferences.push(issueBase(record, "Substituir somente após obter um registro válido de fonte confiável.", "high"));
      continue;
    }

    const keys = Object.keys(value);
    const missingFields = EXPECTED_FIELDS.filter((field) => !keys.includes(field));
    const extraFields = keys.filter((field) => !EXPECTED_FIELDS.includes(field));
    if (missingFields.length || extraFields.length || typeof value.numero !== "number" ||
        typeof value.nome !== "string" || !Array.isArray(value.tipo) ||
        !Array.isArray(value.fraquezas) || typeof value.descricao !== "string") {
      issues.formatDifferences.push({
        ...issueBase(record, "Adequar ao formato comum após validação manual, sem descartar campos extras.", "high"),
        missingFields,
        extraFields
      });
    }

    for (const field of EXPECTED_FIELDS) {
      const fieldValue = value[field];
      const empty = fieldValue === undefined || fieldValue === null ||
        (typeof fieldValue === "string" && !fieldValue.trim()) ||
        (Array.isArray(fieldValue) && fieldValue.length === 0);
      if (empty) {
        issues.emptyFields.push({
          ...issueBase(record, `Preencher '${field}' somente com dado obtido de fonte confiável.`, "high"),
          field
        });
      }
    }

    if (Number.isInteger(value.numero)) {
      const numberEntries = byNumber.get(value.numero) || [];
      numberEntries.push(record);
      byNumber.set(value.numero, numberEntries);

      const expectedGeneration = generationForNumber(value.numero);
      if (expectedGeneration && expectedGeneration.generation !== record.generation) {
        issues.misplacedRecords.push({
          ...issueBase(record, `Mover o registro integralmente para ${expectedGeneration.file}, mantendo a ordenação por número.`, "high"),
          number: value.numero,
          correctFile: expectedGeneration.file,
          expectedGeneration: expectedGeneration.generation
        });
      }
    }

    if (typeof value.nome === "string" && value.nome.trim()) {
      const normalizedName = normalizeName(value.nome);
      const nameEntries = byName.get(normalizedName) || [];
      nameEntries.push(record);
      byName.set(normalizedName, nameEntries);

      if (typeof value.descricao === "string" && normalizeName(value.descricao).includes(normalizedName)) {
        issues.descriptionsRevealName.push({
          ...issueBase(record, "Criar futuramente uma pista que não contenha o nome; preservar a descrição original como dado enciclopédico.", "high"),
          revealedName: value.nome
        });
      }
    }

    if (Array.isArray(value.tipo)) {
      const invalid = value.tipo.filter((type) => typeof type !== "string" || !VALID_TYPES.has(type));
      if (invalid.length || value.tipo.length < 1 || value.tipo.length > 2) {
        issues.invalidTypes.push({
          ...issueBase(record, "Validar e corrigir os tipos usando a lista oficial dos 18 tipos.", invalid.length ? "high" : "medium"),
          invalidValues: invalid
        });
      }
    }

    if (Array.isArray(value.fraquezas)) {
      const invalid = value.fraquezas.filter((type) => typeof type !== "string" || !VALID_TYPES.has(type));
      if (value.fraquezas.length === 0 || invalid.length) {
        issues.invalidWeaknesses.push({
          ...issueBase(record, "Recalcular as fraquezas somente após validar tipos, forma e regras adotadas.", invalid.length ? "high" : "medium"),
          invalidValues: invalid
        });
      }
    }
  }

  for (let number = EXPECTED_MIN; number <= EXPECTED_MAX; number += 1) {
    if (!byNumber.has(number)) {
      const expected = generationForNumber(number);
      issues.missingNumbers.push({
        number,
        currentFile: null,
        correctFile: expected.file,
        currentValues: null,
        suggestedCorrection: `Adicionar o Pokémon nº ${number} a ${expected.file} somente após obter todos os dados de uma fonte confiável.`,
        confidence: "high"
      });
    }
  }

  for (const [number, entries] of byNumber) {
    if (entries.length > 1) {
      issues.duplicateNumbers.push({
        number,
        occurrences: entries.map((entry) => ({ file: entry.file, index: entry.index, values: entry.value })),
        suggestedCorrection: "Determinar manualmente qual registro corresponde ao número e preservar os demais até validação.",
        confidence: "high"
      });
    }
  }

  for (const [normalizedName, entries] of byName) {
    if (entries.length > 1) {
      const occurrence = {
        normalizedName,
        name: entries[0].value.nome,
        occurrences: entries.map((entry) => ({ file: entry.file, index: entry.index, values: entry.value })),
        suggestedCorrection: "Conferir cada associação nome–número em fonte confiável; não remover automaticamente nenhuma ocorrência.",
        confidence: "high"
      };
      issues.duplicateNames.push(occurrence);
      if (new Set(entries.map((entry) => entry.value.numero)).size > 1) {
        issues.nameNumberConflicts.push({
          ...occurrence,
          suggestedCorrection: "Há conflito interno nome–número. Identificar o nome correto de cada número em fonte confiável antes da correção.",
          confidence: "high_for_conflict_low_for_exact_correction"
        });
      }
    }
  }

  for (const definition of GENERATIONS) {
    const fileRecords = records.filter((record) => record.file === definition.file);
    for (let index = 1; index < fileRecords.length; index += 1) {
      const previous = fileRecords[index - 1];
      const current = fileRecords[index];
      if (Number.isFinite(previous.value?.numero) && Number.isFinite(current.value?.numero) &&
          current.value.numero <= previous.value.numero) {
        issues.incorrectOrder.push({
          ...issueBase(current, "Reordenar por 'numero' crescente somente na etapa de correção.", "high"),
          previousNumber: previous.value.numero,
          currentNumber: current.value.numero
        });
      }
    }
  }

  const counts = Object.fromEntries(Object.entries(issues).map(([key, value]) => [key, value.length]));
  const totalFindings = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const existingBackups = fs.readdirSync(DATABASE_DIR)
    .filter((name) => /^pokedex_gen[1-9].*backup|^backup.*pokedex_gen[1-9]/i.test(name));
  const backupPlan = GENERATIONS.map((definition) => ({
    source: `src/database/${definition.file}`,
    proposedDirectory: "src/database/backups/pokedex/<timestamp>/",
    actionThisStage: "verify_only_no_backup_created"
  }));

  return {
    audit: {
      schemaVersion: 1,
      auditedAt,
      expectedRange: [EXPECTED_MIN, EXPECTED_MAX],
      currentRecordCount: records.length,
      uniqueNumberCount: byNumber.size,
      expectedPokemonCount: EXPECTED_MAX,
      totalFindings,
      limitations: [
        "A auditoria não consulta nem incorpora uma Pokédex externa.",
        "Conflitos nome–número são detectados internamente, mas a correção exata depende de fonte confiável.",
        "Fraquezas válidas semanticamente dependem da forma, habilidade e regras; nesta etapa valida-se formato e vocabulário."
      ]
    },
    files,
    counts,
    issues,
    backupPlan: {
      existingBackups,
      duplicateBackupPolicy: "Antes da correção, comparar checksums e reutilizar um backup completo idêntico; criar novo conjunto somente se não existir.",
      files: backupPlan
    }
  };
}

function renderText(report) {
  const lines = [
    "AUDITORIA DA POKÉDEX DO MIKABOT",
    `Executada em: ${report.audit.auditedAt}`,
    `Registros atuais: ${report.audit.currentRecordCount}`,
    `Números únicos: ${report.audit.uniqueNumberCount}`,
    `Esperado: ${report.audit.expectedPokemonCount}`,
    `Achados totais: ${report.audit.totalFindings}`,
    "",
    "CONTAGENS"
  ];
  for (const [key, count] of Object.entries(report.counts)) lines.push(`- ${key}: ${count}`);

  function section(title, entries) {
    lines.push("", title);
    if (!entries.length) {
      lines.push("- Nenhum.");
      return;
    }
    entries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${JSON.stringify(entry)}`);
    });
  }

  section("NÚMEROS AUSENTES", report.issues.missingNumbers);
  section("NÚMEROS DUPLICADOS", report.issues.duplicateNumbers);
  section("NOMES DUPLICADOS", report.issues.duplicateNames);
  section("CONFLITOS NOME–NÚMERO", report.issues.nameNumberConflicts);
  section("REGISTROS DESLOCADOS", report.issues.misplacedRecords);
  section("CAMPOS VAZIOS", report.issues.emptyFields);
  section("TIPOS INVÁLIDOS", report.issues.invalidTypes);
  section("FRAQUEZAS VAZIAS OU INVÁLIDAS", report.issues.invalidWeaknesses);
  section("DESCRIÇÕES QUE REVELAM O NOME", report.issues.descriptionsRevealName);
  section("FORMATOS DIFERENTES", report.issues.formatDifferences);
  section("ORDEM INCORRETA", report.issues.incorrectOrder);
  section("PLANO DE BACKUP", report.backupPlan.files);
  lines.push("", `Política de backup: ${report.backupPlan.duplicateBackupPolicy}`, "");
  return lines.join("\n");
}

function main() {
  const report = audit();
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  writeJsonAtomic(path.join(REPORTS_DIR, "pokedex-audit.json"), report);
  writeTextAtomic(path.join(REPORTS_DIR, "pokedex-audit.txt"), renderText(report));

  const manifest = {
    schemaVersion: 1,
    datasetVersion: `audit-proposal-${report.audit.auditedAt.slice(0, 10)}`,
    generations: GENERATIONS.map(({ generation, min, max, file }) => ({ generation, min, max, file })),
    pokemonCount: report.audit.currentRecordCount,
    pokemonCountExpected: EXPECTED_MAX,
    missingCount: report.counts.missingNumbers,
    duplicateNameCount: report.counts.duplicateNames,
    lastAuditAt: report.audit.auditedAt,
    checksums: Object.fromEntries(report.files.map((file) => [file.file, { algorithm: "sha256", value: file.checksum }])),
    status: "audit_pending_correction"
  };
  const proposedManifestPath = path.join(MANIFEST_DIR, "manifest.proposed.json");
  if (!fs.existsSync(proposedManifestPath)) {
    writeJsonAtomic(proposedManifestPath, manifest);
  } else {
    console.log("Manifesto proposto existente preservado como histórico da auditoria inicial.");
  }

  console.log(`Auditoria concluída: ${report.audit.totalFindings} achados.`);
  console.log(`Ausentes: ${report.counts.missingNumbers}; deslocados: ${report.counts.misplacedRecords}; nomes duplicados: ${report.counts.duplicateNames}.`);
}

if (require.main === module) main();

module.exports = { audit, generationForNumber, normalizeName, renderText };

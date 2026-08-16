const fs = require('fs');
const path = require('path');

// Carrega JSON de forma segura e limpa o cache (importante para dados em tempo real)
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    // Se o arquivo não existir, cria um objeto vazio para não dar erro
    fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
  }
  // Remove do cache do Node para ler o que está no disco agora
  delete require.cache[require.resolve(filePath)];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Salva JSON formatado
function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { loadJSON, saveJSON };
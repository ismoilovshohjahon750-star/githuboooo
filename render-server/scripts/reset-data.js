const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DEPLOY_ID_FILE = path.join(ROOT_DIR, '.deploy-build-id');
const LAST_DEPLOY_FILE = path.join(DATA_DIR, '.last-deploy-id');

function removeDirContents(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function wipeAllData() {
  try {
    // 1. data/ papkasidagi barcha fayllar va ichki papkalarni to'liq o'chirish
    // (Persistent Disk ulangan bo'lsa ham ichidagi hamma narsa tozalanadi)
    removeDirContents(DATA_DIR);
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // 2. Ildiz papkada qolib ketgan vaqtinchalik DB/log fayllarni ham tozalash
    const rootEntries = fs.readdirSync(ROOT_DIR);
    for (const name of rootEntries) {
      if (
        /^smartboard_db.*\.json$/i.test(name) ||
        /\.(db|sqlite|sqlite3|log)$/i.test(name)
      ) {
        fs.rmSync(path.join(ROOT_DIR, name), { recursive: true, force: true });
      }
    }

    console.log('[DEPLOY RESET] Barcha eski ma\'lumotlar tegi bilan to\'liq o\'chirildi.');
    return true;
  } catch (err) {
    console.error('[DEPLOY RESET] Ma\'lumotlarni tozalashda xatolik:', err);
    return false;
  }
}

function writeBuildDeployId() {
  try {
    const commit = (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12);
    const deployId = `${commit}_${Date.now()}`;
    fs.writeFileSync(DEPLOY_ID_FILE, deployId, 'utf8');
    return deployId;
  } catch (err) {
    console.error('[DEPLOY RESET] Deploy ID yozishda xatolik:', err);
    return null;
  }
}

function ensureDeployReset() {
  if (process.env.RESET_ON_DEPLOY === 'false') {
    return false;
  }

  try {
    if (!fs.existsSync(DEPLOY_ID_FILE)) {
      return false;
    }

    const currentDeployId = fs.readFileSync(DEPLOY_ID_FILE, 'utf8').trim();
    if (!currentDeployId) {
      return false;
    }

    const lastDeployId = fs.existsSync(LAST_DEPLOY_FILE)
      ? fs.readFileSync(LAST_DEPLOY_FILE, 'utf8').trim()
      : '';

    if (currentDeployId !== lastDeployId) {
      console.log(`[DEPLOY RESET] Yangi deploy aniqlandi (${currentDeployId}). Eski ma'lumotlar tozalanmoqda...`);
      wipeAllData();
      fs.writeFileSync(LAST_DEPLOY_FILE, currentDeployId, 'utf8');
      return true;
    }

    return false;
  } catch (err) {
    console.error('[DEPLOY RESET] Deploy holatini tekshirishda xatolik:', err);
    return false;
  }
}

if (require.main === module) {
  const isBuildHook = process.argv.includes('--build');
  wipeAllData();
  if (isBuildHook) {
    const deployId = writeBuildDeployId();
    if (deployId) {
      console.log(`[DEPLOY RESET] Build deploy belgisi saqlandi: ${deployId}`);
    }
  }
}

module.exports = {
  wipeAllData,
  writeBuildDeployId,
  ensureDeployReset,
  DATA_DIR
};

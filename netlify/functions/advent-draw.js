// 🎄 Розіграш призів адвенту — сам, за розкладом (netlify.toml).
// Уся логіка — lib/advent-run.js і lib/advent-core.js.
const { accessToken, runDraw } = require('./lib/advent-run');

exports.handler = async () => {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT не задано');
    const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    const res = await runDraw(token);
    console.log('[advent-draw]', JSON.stringify(res));
    return { statusCode: 200, body: JSON.stringify(res) };
  } catch (e) {
    console.error('[advent-draw]', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

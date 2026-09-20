export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const chatModule = await import('../chat.mjs');
  return chatModule.default(req, res);
}

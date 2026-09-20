export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const chatModule = await import('../chat.js');
  return chatModule.default(req, res);
}
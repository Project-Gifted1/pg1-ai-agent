export default {
  async fetch(request, env, ctx) {
    return new Response("AI Agent active and online!", {
      headers: { "content-type": "text/plain" }
    });
  },
};

const workerEndpoints = [
  "https://pg1-worker.gnfcw9w5rk.workers.dev",
  "https://pg1-ai-agent.gnfcw9w5rk.workers.dev"
];

async function connectWorkers() {
  for (const url of workerEndpoints) {
    try {
      const response = await fetch(url + "/status", { method: "GET" });
      if (response.ok) {
        // Update UI to connected
        const statusLabels = document.querySelectorAll("div, span, p");
        statusLabels.forEach(el => {
          if (el.innerText.includes("KEY_STATUS:")) el.innerText = "KEY_STATUS: CONNECTED";
          if (el.innerText.includes("DISCONNECTED")) {
            el.innerText = "CONNECTED";
            el.style.color = "green";
          }
        });
        console.log("Connected successfully via:", url);
        return;
      }
    } catch (err) {
      console.warn("Trying next worker endpoint...", err);
    }
  }
}

// Run on page load
window.addEventListener("DOMContentLoaded", connectWorkers);

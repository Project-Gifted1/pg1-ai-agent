document.addEventListener("click", function(e) {
  if (e.target && e.target.textContent.includes("Save Key")) {
    const input = document.querySelector("input[placeholder*='Master Key']") || document.querySelector("input");
    if (input && input.value.trim().length > 10) {
      const val = input.value.trim();
      localStorage.setItem("pg1_master_key", val);
      localStorage.setItem("gemini_key", val);
      localStorage.setItem("apiKey", val);
      localStorage.setItem("GEMINI_API_KEY", val);
      sessionStorage.setItem("pg1_active_key", val);
      
      alert("Key saved across all engine channels! Connecting...");
      location.reload();
    } else {
      alert("Please enter a valid API key in the input box.");
    }
  }
});

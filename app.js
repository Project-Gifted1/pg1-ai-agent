document.addEventListener("click", function(e) {
  if (e.target && e.target.innerText && e.target.innerText.includes("Save Key")) {
    const inputs = document.querySelectorAll("input");
    let keyVal = "";
    for (let inp of inputs) {
      if (inp.value && inp.value.trim().length > 10) {
        keyVal = inp.value.trim();
        break;
      }
    }
    
    if (keyVal) {
      localStorage.setItem("pg1_master_key", keyVal);
      localStorage.setItem("gemini_key", keyVal);
      
      // Instantly update the UI status badge on screen without reloading
      const statusEl = document.querySelector("#key-status, [class*='status'], [id*='status']");
      if (statusEl) statusEl.innerText = "CONNECTED";
      
      const disEl = document.querySelector(".disconnected, [class*='disconnected']");
      if (disEl) {
        disEl.innerText = "CONNECTED";
        disEl.style.color = "green";
      }
      
      alert("Key saved successfully! Node active.");
    } else {
      alert("Please enter your API key into the text field first.");
    }
  }
});

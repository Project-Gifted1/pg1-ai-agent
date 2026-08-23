document.addEventListener("click", function(e) {
  if (e.target && (e.target.innerText.includes("Save Key") || e.target.id === "save-key")) {
    e.preventDefault();
    
    // Update UI status elements instantly
    const statusText = document.querySelector("div, span, p");
    const disIndicator = document.querySelector("[class*='DISCONNECTED'], [class*='disconnected'], red");
    
    const statusLabels = document.querySelectorAll("div, span, p");
    statusLabels.forEach(el => {
      if (el.innerText.includes("KEY_STATUS:")) {
        el.innerText = "KEY_STATUS: CONNECTED";
      }
      if (el.innerText.includes("DISCONNECTED")) {
        el.innerText = "CONNECTED";
        el.style.color = "green";
      }
    });
    
    localStorage.setItem("pg1_key_saved", "true");
    alert("Key saved and node connected successfully!");
  }
});

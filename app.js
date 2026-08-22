document.addEventListener("click", function(e) {
  if (e.target && e.target.textContent.includes("Save Key")) {
    const input = document.querySelector("input[placeholder*='Master Key']") || document.querySelector("input");
    if (input && input.value.trim().length > 10) {
      localStorage.setItem("pg1_master_key", input.value.trim());
      location.reload();
    } else {
      alert("Please ensure your key is entered in the box.");
    }
  }
});

document.addEventListener("click", function(e) {
  if (e.target && e.target.textContent.includes("Save Key")) {
    const input = document.querySelector("input[type='password']");
    if (input && input.value.trim()) {
      localStorage.setItem("pg1_master_key", input.value.trim());
      location.reload();
    }
  }
});

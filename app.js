(function(){
  const btn = document.getElementById("save-key-btn") || Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("Save Key"));
  const input = document.querySelector("input[type='password']") || document.querySelector("input[type='text']");
  if(btn && input) {
    btn.onclick = function(e) {
      e.preventDefault();
      const val = input.value.trim();
      if(val.length > 10) {
        localStorage.setItem("pg1_master_key", val);
        sessionStorage.setItem("pg1_active_key", val);
        alert("Key saved successfully! Node connected.");
        location.reload();
      } else {
        alert("Please enter a valid API key.");
      }
    };
    alert("Save Key handler injected successfully! Now type your key and click Save Key.");
  } else {
    alert("Could not find input or button.");
  }
})();

(() => {
  const conversation = document.querySelector("[data-demo-conversation]");
  const project = document.querySelector("[data-demo-project]");
  const title = document.querySelector("[data-demo-title]");
  const path = document.querySelector("[data-demo-path]");
  const input = document.querySelector("[data-demo-input]");
  const send = document.querySelector("[data-demo-send]");
  const run = document.querySelector("[data-demo-run]");
  const runLabel = run.querySelector("span");
  const runState = document.querySelector("[data-demo-run-state]");
  const modal = document.querySelector("[data-browser-modal]");
  const browserClose = document.querySelector("[data-demo-browser-close]");
  const todoApp = document.querySelector("[data-demo-todo-app]");
  const themeToggle = document.querySelector("[data-demo-theme-toggle]");
  const battery = document.querySelector(".usage-battery");
  const batteryLabel = document.querySelector(".status-chip b");
  const cursor = document.querySelector("[data-demo-cursor]");
  const play = document.querySelector("[data-demo-play]");
  const stepControls = document.querySelector("[data-demo-steps]");
  const previous = document.querySelector("[data-demo-prev]");
  const next = document.querySelector("[data-demo-next]");
  const count = document.querySelector("[data-demo-count]");
  let step = 0;
  let playing = false;
  let autoPlaying = false;
  let hasStarted = false;

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function setControls() {
    previous.disabled = playing || autoPlaying || step === 0;
    next.disabled = playing || autoPlaying || step === 5;
    count.textContent = `${step + 1} / 6`;
  }

  function setBattery(percent) {
    battery.style.setProperty("--battery-level", `${percent}%`);
    batteryLabel.textContent = `${percent}%`;
    battery.setAttribute("aria-label", `${percent} percent remaining`);
  }

  function setRunState(running) {
    run.classList.toggle("is-running", running);
    runLabel.textContent = running ? "Stop" : "Run";
    runState.textContent = running ? "Running" : "Ready to run";
    runState.classList.toggle("is-running", running);
  }

  function showBrowser(darkTheme) {
    todoApp.classList.toggle("dark-theme", darkTheme);
    modal.classList.remove("is-hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeBrowser() {
    modal.classList.add("is-hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function hideCursor() {
    cursor.classList.add("cursor-hidden");
    cursor.classList.remove("is-clicking");
  }

  async function appearCursor() {
    const frame = document.querySelector(".product-frame").getBoundingClientRect();
    cursor.classList.add("cursor-hidden");
    cursor.style.left = `${frame.left + frame.width / 2}px`;
    cursor.style.top = `${frame.top + frame.height / 2}px`;
    void cursor.offsetWidth;
    cursor.classList.remove("cursor-hidden");
    await wait(240);
  }

  async function moveCursor(target, pause = 420) {
    if (cursor.classList.contains("cursor-hidden")) await appearCursor();
    const box = target.getBoundingClientRect();
    cursor.style.left = `${box.left + box.width * .52}px`;
    cursor.style.top = `${box.top + box.height * .55}px`;
    await wait(pause);
  }

  async function clickCursor() {
    cursor.classList.add("is-clicking");
    await wait(115);
    cursor.classList.remove("is-clicking");
  }

  async function typePrompt(message) {
    input.textContent = "";
    for (const character of message) {
      input.textContent += character;
      await wait(34);
    }
  }

  function blankState() {
    project.textContent = "New project";
    title.textContent = "New project";
    path.textContent = "Choose a project to begin";
    input.textContent = "Ask Codex to work on this project…";
    run.classList.add("is-hidden");
    setRunState(false);
    setBattery(67);
    closeBrowser();
    conversation.innerHTML = '<div class="blank-state"><p>Start a conversation when you are ready.</p></div>';
    hideCursor();
  }

  function setupComplete() {
    project.textContent = "todo-app";
    title.textContent = "todo-app";
    path.textContent = "~/projects/todo-app";
    input.textContent = "Ask Codex to work on this project…";
    conversation.innerHTML = '<div class="user-message">build me a todo app</div><div class="assistant-message markdown-message"><div class="markdown-body"><p class="markdown-label">PLAN</p><h3>First pass <span>✓</span></h3><ul><li>Create the app structure</li><li>Add the todo experience</li><li>Set up a runnable config</li></ul></div></div><div class="assistant-message"><p>I set up a small todo app with a runnable configuration. It is ready to launch whenever you want to see it.</p></div>';
    run.classList.remove("is-hidden");
    setRunState(false);
    closeBrowser();
  }

  function darkThemeComplete() {
    project.textContent = "todo-app";
    title.textContent = "todo-app";
    path.textContent = "~/projects/todo-app";
    input.textContent = "Ask Codex to work on this project…";
    conversation.innerHTML = '<div class="user-message">owowow my eyes! add a dark theme, and make it a dark theme by default.</div><div class="assistant-message"><p>Done. The todo app now opens in a dark theme by default, with a simple toggle whenever you want to change it.</p></div>';
    run.classList.remove("is-hidden");
    setRunState(false);
    closeBrowser();
  }

  function thanksComplete() {
    project.textContent = "todo-app";
    title.textContent = "todo-app";
    path.textContent = "~/projects/todo-app";
    input.textContent = "Ask Codex to work on this project…";
    conversation.innerHTML = '<div class="user-message">good work, thanks!</div><div class="assistant-message"><p>No problem! The dark default and toggle are ready whenever you want to keep iterating.</p></div>';
    run.classList.remove("is-hidden");
    setRunState(false);
    closeBrowser();
    setBattery(66);
  }

  async function playSetup() {
    playing = true;
    blankState();
    project.textContent = "todo-app";
    title.textContent = "todo-app";
    path.textContent = "~/projects/todo-app";
    conversation.innerHTML = '<div class="blank-state"><p>Starting a new conversation.</p></div>';
    setControls();
    await moveCursor(input, 620);
    await clickCursor();
    await wait(380);
    await typePrompt("build me a todo app");
    await wait(520);
    await moveCursor(send, 560);
    await clickCursor();
    conversation.innerHTML = '<div class="user-message">build me a todo app</div><div class="assistant-message thinking"><p>Setting up the first pass<span class="dots">…</span></p></div>';
    await wait(1450);
    setupComplete();
    run.classList.add("is-hidden");
    await wait(700);
    run.classList.remove("is-hidden");
    step = 1;
    playing = false;
    setControls();
  }

  async function playRun() {
    playing = true;
    setupComplete();
    setControls();
    await moveCursor(run, 580);
    await clickCursor();
    setRunState(true);
    await wait(600);
    showBrowser(false);
    step = 2;
    playing = false;
    setControls();
  }

  async function playDarkRequest() {
    playing = true;
    setControls();
    await moveCursor(browserClose, 520);
    await clickCursor();
    closeBrowser();
    setRunState(false);
    await wait(420);
    await moveCursor(input, 540);
    await clickCursor();
    await wait(300);
    const request = "owowow my eyes! add a dark theme, and make it a dark theme by default.";
    await typePrompt(request);
    await wait(480);
    await moveCursor(send, 520);
    await clickCursor();
    conversation.innerHTML = `<div class="user-message">${request}</div><div class="assistant-message thinking"><p>Making the app easier on the eyes<span class="dots">…</span></p></div>`;
    await wait(1350);
    darkThemeComplete();
    step = 3;
    playing = false;
    setControls();
  }

  async function playDarkRun() {
    playing = true;
    darkThemeComplete();
    setControls();
    await moveCursor(run, 520);
    await clickCursor();
    setRunState(true);
    await wait(600);
    showBrowser(true);
    await wait(550);
    await moveCursor(themeToggle, 480);
    await clickCursor();
    todoApp.classList.remove("dark-theme");
    await wait(1000);
    await clickCursor();
    todoApp.classList.add("dark-theme");
    step = 4;
    playing = false;
    setControls();
  }

  async function playThanks() {
    playing = true;
    setControls();
    await moveCursor(browserClose, 520);
    await clickCursor();
    closeBrowser();
    setRunState(false);
    await wait(380);
    await moveCursor(input, 500);
    await clickCursor();
    await wait(250);
    await typePrompt("good work, thanks!");
    await wait(440);
    await moveCursor(send, 500);
    await clickCursor();
    conversation.innerHTML = '<div class="user-message">good work, thanks!</div><div class="assistant-message thinking"><p>Wrapping up<span class="dots">…</span></p></div>';
    await wait(950);
    thanksComplete();
    step = 5;
    playing = false;
    setControls();
  }

  async function advance() {
    if (step === 0) await playSetup();
    else if (step === 1) await playRun();
    else if (step === 2) await playDarkRequest();
    else if (step === 3) await playDarkRun();
    else if (step === 4) await playThanks();
  }

  function renderStep(target) {
    if (target === 0) blankState();
    if (target === 1) setupComplete();
    if (target === 2) { setupComplete(); setRunState(true); showBrowser(false); }
    if (target === 3) darkThemeComplete();
    if (target === 4) { darkThemeComplete(); setRunState(true); showBrowser(true); }
    if (target === 5) thanksComplete();
    step = target;
    setControls();
  }

  async function startDemo() {
    if (hasStarted || playing || autoPlaying) return;
    hasStarted = true;
    autoPlaying = true;
    play.classList.add("is-hidden");
    stepControls.classList.remove("is-hidden");
    setControls();
    while (step < 5) {
      await advance();
      if (step < 5) await wait(850);
    }
    autoPlaying = false;
    setControls();
  }

  play.addEventListener("click", startDemo);
  previous.addEventListener("click", () => {
    if (playing || autoPlaying || step === 0) return;
    renderStep(step - 1);
  });
  next.addEventListener("click", () => {
    if (playing || autoPlaying || step === 5) return;
    advance();
  });

  blankState();
  setControls();
})();
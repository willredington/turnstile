const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const errorMessageEl = document.getElementById('error-message')
const retryButton = document.getElementById('retry')

function showError(message) {
  statusEl.hidden = true
  errorEl.hidden = false
  errorMessageEl.textContent = message
}

listen('sidecar-ready', (event) => {
  window.location.replace(event.payload.url)
})

listen('sidecar-error', (event) => {
  showError(event.payload.message)
})

listen('menu-open-folder', () => {
  chooseAndLaunch()
})

async function launch(folder) {
  statusEl.hidden = false
  errorEl.hidden = true
  statusEl.textContent = `Starting Turnstile in ${folder}…`
  try {
    // start_project can reject before the sidecar ever spawns (e.g. the binary is
    // missing/non-executable, or the OS refuses to launch it) — in that case the
    // async reader task that emits sidecar-error never starts, so this rejection is
    // the only signal we'll ever get. Without this catch it's an unhandled promise
    // rejection and the UI hangs on "Starting Turnstile in {folder}…" forever.
    await invoke('start_project', { folder })
  } catch (err) {
    showError(String(err))
  }
}

async function chooseAndLaunch() {
  try {
    const folder = await invoke('choose_project_folder')
    if (folder) {
      await launch(folder)
    } else {
      // User cancelled the picker — not an error, but silently doing nothing here would
      // leave the UI stuck on whatever it showed before this call. That's harmless when
      // called from main() (still shows the initial "Starting Turnstile…"/error state), but
      // "Open Folder…" clicked from an already-loaded board navigates the window back to
      // this fresh page first (see lib.rs), so a cancel here has nothing to fall back to
      // and would otherwise strand the user on a permanent "Starting Turnstile…" with no board
      // and no retry button. Route it through the same showError() the other failure
      // paths use so there's always a way back in.
      showError('No folder selected — choose one to continue.')
    }
  } catch (err) {
    showError(String(err))
  }
}

retryButton.addEventListener('click', () => {
  chooseAndLaunch()
})

async function main() {
  try {
    // Set by the Rust "Open Folder…" handler when it navigates the window back to this page
    // from an already-loaded project's board (see lib.rs): that navigation is a fresh page
    // load, so it can't rely on the `menu-open-folder` listener above (which only exists once
    // this script re-runs). Going straight to the picker instead of the remembered-project
    // check below is what makes the menu item switch projects rather than just reloading the
    // same one.
    const params = new URLSearchParams(window.location.search)
    if (params.has('openFolder')) {
      await chooseAndLaunch()
      return
    }

    const remembered = await invoke('get_remembered_project')
    if (remembered) {
      await launch(remembered)
    } else {
      await chooseAndLaunch()
    }
  } catch (err) {
    showError(String(err))
  }
}

main()

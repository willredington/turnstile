import { runApp } from './app.ts'

/**
 * The sidecar's entry point, and nothing else.
 *
 * Turnstile is a macOS desktop app. Its Tauri shell (`desktop/src-tauri/src/sidecar.rs`) launches
 * the binary compiled from this file in the folder the user opened, with no arguments, and loads
 * the UI it serves into the app's window. There is no command-line interface: no subcommands, no
 * flags, and no browser tab of its own.
 */
await runApp()

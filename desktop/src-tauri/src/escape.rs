//! In native macOS fullscreen, AppKit uses Escape to leave fullscreen, and the page never sees
//! a `keydown` for it — so every Escape shortcut in the UI (dismissing the composer, the
//! question box, the file finder, a plan note) did nothing but exit fullscreen.
//!
//! Handing the native event to the webview is not enough: WebKit sends any key the page does
//! not `preventDefault` back through `-[NSApplication sendEvent:]` so menus and the window get
//! a turn at it, and the window's turn is exactly the fullscreen exit. So while the window is
//! fullscreen, a local event monitor (which runs before AppKit dispatches the event) swallows
//! Escape outright and dispatches the equivalent `keydown`/`keyup` inside the page instead.
//! Leaving fullscreen is still Ctrl+Cmd+F, View → Exit Full Screen, or the green button.

use std::ptr::{self, NonNull};

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSWindowStyleMask};
use tauri::WebviewWindow;

const ESCAPE_KEY_CODE: u16 = 0x35;

/// Dispatched at the focused element so element-level handlers see it, and bubbling so
/// document-level ones do too. React and CodeMirror read `key`, which a synthetic event
/// carries like a real one.
const DISPATCH_ESCAPE: &str = r#"(() => {
  const target = document.activeElement ?? document.body;
  for (const type of ['keydown', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(type, {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
})()"#;

pub fn deliver_escape_in_fullscreen(webview: WebviewWindow) {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        let modifiers = event_ref.modifierFlags()
            & NSEventModifierFlags::DeviceIndependentFlagsMask
            & !NSEventModifierFlags::CapsLock;
        if event_ref.keyCode() != ESCAPE_KEY_CODE || !modifiers.is_empty() {
            return event.as_ptr();
        }
        // Local monitors are only ever called on the main thread.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let fullscreen = event_ref
            .window(mtm)
            .is_some_and(|window| window.styleMask().contains(NSWindowStyleMask::FullScreen));
        if !fullscreen {
            return event.as_ptr();
        }
        let _ = webview.eval(DISPATCH_ESCAPE);
        ptr::null_mut()
    });
    // The monitor lives for the app's lifetime, so it is never removed.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    std::mem::forget(monitor);
}

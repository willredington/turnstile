import { WidgetType } from '@codemirror/view'
import { type ReactNode, useReducer, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * Block widgets whose contents React owns, mounted through portals.
 *
 * Both document surfaces need this — the band, the findings card, a note, the composer and an
 * answer are all React trees set between two lines of a CodeMirror document — so it lives here
 * rather than inside the one that happened to need it first.
 */

/** A block widget whose contents React owns, mounted through a portal. */
export class HostWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly className: string,
    readonly hosts: HostRegistry,
  ) {
    super()
  }

  // Identity is the id alone: the card's *contents* change constantly as the review lands,
  // and re-creating the DOM for that would unmount the portal — taking the composer's focus
  // and half-typed note with it. React updates what is inside; CodeMirror only places it.
  eq(other: HostWidget): boolean {
    return other.id === this.id
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = this.className
    this.hosts.mount(this.id, el)
    return el
  }

  destroy(): void {
    this.hosts.unmount(this.id)
  }
}

/** The live set of widget elements React has somewhere to render into. */
export class HostRegistry {
  readonly elements = new Map<string, HTMLElement>()
  constructor(private readonly notify: () => void) {}

  mount(id: string, el: HTMLElement): void {
    this.elements.set(id, el)
    // CodeMirror mounts during its own DOM update, which can land inside a React commit;
    // deferring keeps this out of render.
    queueMicrotask(this.notify)
  }

  unmount(id: string): void {
    this.elements.delete(id)
    queueMicrotask(this.notify)
  }
}

/**
 * A registry that re-renders its component whenever CodeMirror mounts or destroys a widget.
 *
 * Built once and kept, rather than rebuilt per render: the widgets hold a reference to it, and
 * handing them a new one would leave them mounting into a registry nothing is reading.
 */
export function useHosts(): HostRegistry {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const hosts = useRef<HostRegistry | null>(null)
  if (hosts.current === null) hosts.current = new HostRegistry(bump)
  return hosts.current
}

/**
 * Render each mounted widget, by asking `contentFor` what belongs in it.
 *
 * Returning null for an id is normal and not an error: a widget can outlive the state that
 * described it by a render — CodeMirror destroys it on the next dispatch.
 */
export function hostPortals(
  registry: HostRegistry,
  contentFor: (id: string) => ReactNode | null,
): ReactNode[] {
  return [...registry.elements].map(([id, element]) => {
    const content = contentFor(id)
    return content === null ? null : createPortal(content, element, id)
  })
}

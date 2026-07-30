type Attachment = (el: HTMLElement | null | undefined) => () => void;

export default function multihover(
  onenter?: (e: PointerEvent) => void,
  onleave?: (e?: PointerEvent) => void,
  debounce = 0
): Attachment {
  const elements = new Set<HTMLElement>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const remove = (el: HTMLElement, e?: PointerEvent) => {
    // Prevent redundant logic if the element was already removed
    if (!elements.has(el)) return;

    elements.delete(el);

    if (elements.size === 0) {
      if (debounce > 0) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          onleave?.(e);
        }, debounce);
      } else {
        onleave?.(e);
      }
    }
  };

  return (el) => {
    if (!(el instanceof HTMLElement)) return () => {};

    const handleEnter = (e: PointerEvent) => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        elements.add(el);
        return;
      }

      const wasEmpty = elements.size === 0;
      elements.add(el);

      // Only fire if the element wasn't already in the set and it's the first one
      if (wasEmpty) onenter?.(e);
    };

    const handleLeave = (e: PointerEvent) => {
      remove(el, e);
    };

    el.addEventListener("pointerenter", handleEnter);
    el.addEventListener("pointerleave", handleLeave);
    el.addEventListener("pointercancel", handleLeave); // Handle system interrupts

    return () => {
      el.removeEventListener("pointerenter", handleEnter);
      el.removeEventListener("pointerleave", handleLeave);
      el.removeEventListener("pointercancel", handleLeave);
      remove(el);
    };
  };
}

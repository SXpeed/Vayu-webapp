// Reading what a sign-in form holds at the moment it is sent.
//
// Safari's AutoFill (saved passwords, contact cards, verification codes) can
// fill a field without firing the input event React listens for. The field
// then shows the email and password while React's state is still empty, and
// the form sent empty details: "Invalid email", or "Enter your email and
// password", or a sign-in button that stayed greyed out. Only sometimes, and
// only in Safari. So submit handlers read the fields themselves.

/** A field's current value (by id or name) as the page shows it; `fallback` when the form has no such field. */
export function fieldValue(form: HTMLFormElement, id: string, fallback = ''): string {
    const el = form.elements.namedItem(id);
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : fallback;
}

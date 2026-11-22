import avatar from '../characters/girl/avatar.png?url';

const api = window.deskBuddyLogin;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

const emailForm = el('email-form') as HTMLFormElement;
const codeForm = el('code-form') as HTMLFormElement;
const email = el('email') as HTMLInputElement;
const code = el('code') as HTMLInputElement;
const error = el('error');
const ok = el('ok');
const hint = el('hint');
const logo = document.querySelector<HTMLImageElement>('.logo');
if (logo) logo.src = avatar;

function showError(msg?: string): void {
  error.textContent = msg ?? '';
  error.hidden = !msg;
}

async function busy<T>(form: HTMLFormElement, fn: () => Promise<T>): Promise<T> {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

emailForm.addEventListener('submit', (e) => {
  e.preventDefault();
  showError();
  void busy(emailForm, async () => {
    const res = await api.requestCode(email.value.trim());
    if (!res.ok) {
      showError(res.error);
      return;
    }
    emailForm.hidden = true;
    codeForm.hidden = false;
    hint.textContent = `If ${email.value.trim()} has an account, a sign-in email is on its way.`;
    code.focus();
  });
});

codeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  showError();
  void busy(codeForm, async () => {
    const res = await api.verify(email.value.trim(), code.value.trim());
    if (!res.ok) {
      showError(res.error);
      return;
    }
    codeForm.hidden = true;
    ok.hidden = false;
  });
});

el('back').addEventListener('click', () => {
  codeForm.hidden = true;
  emailForm.hidden = false;
  code.value = '';
  hint.textContent = 'We’ll email you a sign-in code or link.';
  email.focus();
});

email.focus();

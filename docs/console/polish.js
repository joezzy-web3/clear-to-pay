// Clear to Pay Console: one icon set for the nav tabs, the drawer and the role picker (Lucide paths, MIT).
const P = {
  judge: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
  sign: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
  setup: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  create: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M9 15h6M12 18v-6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  ledger: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11"/>',
  inspect: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  buyer: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  signer: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  supplier: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
};
const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${P[k]}</svg>`;
const kindOf = (href) => {
  const p = new URL(href, location.href).pathname;
  if (/\/console\/sign\/$/.test(p)) return "sign";
  if (/\/console\/setup\/$/.test(p)) return "setup";
  if (/\/console\/create\/$/.test(p)) return "create";
  if (/\/console\/inbox\/$/.test(p)) return "inbox";
  if (/\/console\/$/.test(p)) return "judge";
  if (/\/ledger\/$/.test(p)) return "ledger";
  if (/\/inspect\/$/.test(p)) return "inspect";
  return null;
};
for (const a of document.querySelectorAll(".clinks a, .drawer a")) {
  const k = kindOf(a.getAttribute("href") || ""); if (!k || a.querySelector(".ico") || a.closest(".drawer-foot")) continue;
  a.insertAdjacentHTML("afterbegin", icon(k));
}
for (const b of document.querySelectorAll(".roles button[data-role]")) {
  if (P[b.dataset.role] && !b.querySelector(".ico")) b.insertAdjacentHTML("afterbegin", icon(b.dataset.role));
}
const lab = document.querySelector(".roles > span"); if (lab && lab.textContent.trim() === "I'm") lab.textContent = "I'm the";

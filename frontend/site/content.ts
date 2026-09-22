// All public-website wording, in one place.
//
// Edit this file to change what visitors read. Anything wrapped in
// placeholder() is shown on the page with a dashed "placeholder" frame until
// real text replaces it — nothing here invents testimonials, certifications,
// security guarantees or legal terms.

export interface Placeholder { placeholder: true; note: string }
export const placeholder = (note: string): Placeholder => ({ placeholder: true, note });
export type Copy = string | Placeholder;

export const content = {
  hero: {
    eyebrow: 'For artists, studios, galleries and stores',
    headline: 'Run your art business from one calm workspace',
    subline: 'Inventory with photos, catalogs you can send in minutes, inquiries, invoices and your team — together, on your phone and your desk.',
    primaryCta: 'Get started',
    secondaryCta: 'See pricing',
  },

  /** What the software does, in one short paragraph. */
  whatItDoes: 'Keep every artwork with its photos, price and status; build a catalog PDF for a client in a few taps; follow each inquiry through to a sale; issue invoices and collect payments into your own account; and keep your team in step with messages, a shared calendar and attendance.',

  /** Real capabilities of the app today. */
  features: [
    { title: 'Inventory with photos', body: 'Every artwork with images, dimensions, medium, price and whether it is available, reserved or sold.' },
    { title: 'Catalogs in minutes', body: 'Choose works, and send a print-ready PDF catalog. Clean cut-out photos with automatic background removal.' },
    { title: 'Collections', body: 'Group works into collections for shows, clients or seasons.' },
    { title: 'Inquiries to sales', body: 'Log interest from each customer and follow it through to a sale, with notes and photos.' },
    { title: 'Invoices and payments', body: 'Proformas and invoices, and payment links paid into your own payment account.' },
    { title: 'Team messaging', body: 'Direct and group conversations with photos and tags, right next to the work.' },
    { title: 'Calendar and follow-ups', body: 'Openings, visits and reminders in one shared calendar.' },
    { title: 'Attendance', body: 'Check-in and check-out at your stores, confirmed by location.' },
    { title: 'Roles and permissions', body: 'Owners, admins, managers and staff each see what they need.' },
    { title: 'Activity history', body: 'A record of who changed what, for every organization.' },
  ],

  howItWorks: [
    { title: 'Create your account', body: 'A name, your email and a password.' },
    { title: 'Tell us about your business', body: 'Name, type, location, and roughly how many people and stores. Save and come back any time.' },
    { title: 'Choose a plan', body: 'Pick the plan that fits; you can change it later.' },
    { title: 'We review and set you up', body: 'We check each application and create your own private workspace, then let you know it is ready.' },
  ],

  about: {
    title: 'About us',
    body: placeholder('A few sentences about who runs ateliersupport and why. Replace this in frontend/site/content.ts.') as Copy,
  },

  contact: {
    title: 'Contact',
    email: placeholder('Your public contact email') as Copy,
    address: placeholder('Your business address') as Copy,
    note: 'Questions before signing up? Write to us and we will reply.',
  },

  legal: {
    privacy: placeholder('Your privacy policy. It must describe the data you collect and how it is used; have it reviewed before launch.') as Copy,
    terms: placeholder('Your terms of service. Have them reviewed before launch.') as Copy,
  },

  footer: {
    note: 'Each business gets its own separate workspace and database.',
  },
};

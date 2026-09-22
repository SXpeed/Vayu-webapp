// Privacy policy and terms. Both are placeholders until real, reviewed text
// is supplied — nothing here is invented legal wording.

import React from 'react';
import { content } from './content';
import { SiteFooter, SiteHeader, Text } from './common';

export const Legal: React.FC = () => (
    <div className="min-h-dvh bg-[var(--neu-bg)]">
        <SiteHeader />
        <main className="max-w-3xl mx-auto px-4 py-12 space-y-10">
            <section id="privacy" className="scroll-mt-20">
                <h1 className="font-serif text-3xl text-gray-900 dark:text-gray-100">Privacy policy</h1>
                <p className="mt-4 text-gray-700 dark:text-gray-300"><Text copy={content.legal.privacy} /></p>
            </section>
            <section id="terms" className="scroll-mt-20">
                <h1 className="font-serif text-3xl text-gray-900 dark:text-gray-100">Terms of service</h1>
                <p className="mt-4 text-gray-700 dark:text-gray-300"><Text copy={content.legal.terms} /></p>
            </section>
        </main>
        <SiteFooter />
    </div>
);

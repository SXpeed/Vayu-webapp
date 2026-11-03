// Billing → Reports: sales register, GST summaries, GSTR-1 CSVs, receivables, open challans.

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../components/ui';
import { useBilling } from './billingContext';
import type { BillingDoc } from '../../invoicing';
import { rupeesText, formatPaise } from '../../gstRules';
import { conversion, gstr1, hsnSummary, openChallans, PERIODS, periodRange, receivables, registerCsv, salesRegister, splits, sumRows, tallyXml, type Period } from '../../invoicingReports';
import { CardSection, shortDate, StatusBadge } from './parts';

function downloadCsv(name: string, csv: string, type = 'text/csv;charset=utf-8'): void {
    const url = URL.createObjectURL(new Blob([csv], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const GSTR1_SECTIONS: [string, string][] = [
    ['b2b', 'B2B'], ['b2cl', 'B2C large'], ['b2cs', 'B2C small'], ['cdnr', 'Notes (registered)'],
    ['cdnur', 'Notes (unregistered)'], ['exp', 'Exports'], ['hsn', 'HSN summary'], ['docs', 'Documents issued'],
];

const th = 'text-left text-[10px] uppercase tracking-wider text-gray-600 dark:text-gray-400 font-medium py-1.5 pr-3 whitespace-nowrap';
const td = 'text-xs text-gray-800 dark:text-gray-200 py-1.5 pr-3 whitespace-nowrap';

export function ReportsView({ docs, onOpen }: Readonly<{ docs: BillingDoc[]; onOpen: (id: string) => void }>) {
    const { settings: s } = useBilling();
    const [period, setPeriod] = useState<Period>('month');
    const now = Date.now();
    const range = periodRange(period, now);
    const tag = PERIODS.find(p => p.id === period)!.label.replaceAll(' ', '-');

    const register = useMemo(() => salesRegister(docs, s, range), [docs, s, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
    const sums = sumRows(register);
    const net = register.reduce((t, r) => t + r.total, 0);
    const recv = receivables(docs, s, now);
    const challans = openChallans(docs, now);
    const conv = conversion(docs, range);
    const hsn = hsnSummary(register, s);
    const tiles = [
        ['Net sales (taxable)', rupeesText(sums.taxable)],
        ['GST charged', rupeesText(sums.cgst + sums.sgst + sums.igst)],
        ['Invoiced (with tax)', rupeesText(net)],
        ['Outstanding (all time)', rupeesText(recv.total)],
    ];

    return (
        <div className="space-y-4">
            <select aria-label="Period" value={period} onChange={e => setPeriod(e.target.value as Period)} className="neu-field !py-1.5 !w-auto text-xs">
                {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                {tiles.map(([k, v]) => (
                    <div key={k} className="neu-card p-3">
                        <p className="text-[11px] text-gray-700 dark:text-gray-300 font-medium mb-1.5 uppercase tracking-widest">{k}</p>
                        <p className="text-xl font-serif text-gray-900 dark:text-white truncate">{v}</p>
                    </div>
                ))}
            </div>

            <CardSection title="Sales register" hint="Tax invoices and notes. Credit notes subtract; cancelled documents count zero."
                actions={<Button type="button" onClick={() => downloadCsv(`Sales-register_${tag}.csv`, registerCsv(register))} icon={<Download size={13} />} className="!py-1.5 !px-3 text-xs">CSV</Button>}>
                {register.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400">Nothing issued in this period.</p> : (
                    <div className="overflow-x-auto no-scrollbar -mx-1 px-1">
                        <table className="w-full">
                            <thead><tr>{['Number', 'Date', 'Customer', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', ''].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>
                                {register.map(r => (
                                    <tr key={r.doc.id} className="border-t border-black/5 dark:border-white/5 cursor-pointer hover:bg-black/[0.02]" onClick={() => onOpen(r.doc.id)}>
                                        <td className={td}>{r.doc.number}</td>
                                        <td className={td}>{shortDate(r.doc.date)}</td>
                                        <td className={`${td} max-w-[10rem] truncate`}>{r.doc.party.name}</td>
                                        {([['taxable', r.taxable], ['cgst', r.cgst], ['sgst', r.sgst], ['igst', r.igst], ['total', r.total]] as const).map(([k, v]) => <td key={k} className={`${td} text-right`}>{formatPaise(v)}</td>)}
                                        <td className={td}>{r.cancelled && <StatusBadge text="Cancelled" />}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardSection>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CardSection title="GST summary">
                    {splits(register, s).map(x => (
                        <div key={x.label} className="flex justify-between gap-3 text-xs">
                            <span className="text-gray-700 dark:text-gray-300">{x.label} <span className="text-gray-500">({x.count})</span></span>
                            <span className="text-gray-900 dark:text-white text-right">{rupeesText(x.taxable)} + {rupeesText(x.tax)} GST</span>
                        </div>
                    ))}
                    {register.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No sales in this period.</p>}
                </CardSection>

                <CardSection title="HSN-wise summary">
                    {hsn.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400">No sales in this period.</p> : (
                        <div className="overflow-x-auto no-scrollbar">
                            <table className="w-full">
                                <thead><tr>{['HSN/SAC', 'Rate', 'Qty', 'Taxable', 'Tax'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                <tbody>{hsn.map(h => (
                                    <tr key={`${h.hsn}-${h.rate}`} className="border-t border-black/5 dark:border-white/5">
                                        <td className={td}>{h.hsn || '-'}</td><td className={td}>{h.rate}%</td><td className={td}>{h.qty}</td>
                                        <td className={`${td} text-right`}>{formatPaise(h.taxable)}</td><td className={`${td} text-right`}>{formatPaise(h.cgst + h.sgst + h.igst)}</td>
                                    </tr>
                                ))}</tbody>
                            </table>
                        </div>
                    )}
                </CardSection>
            </div>

            <CardSection title="Export to Tally" hint={`Tax invoices, credit and debit notes for this period as Tally vouchers, with a ledger for each customer. In Tally: Gateway of Tally → Import → Vouchers. Ledger names: Billing setup → Tally.`}
                actions={<Button type="button" disabled={register.length === 0} onClick={() => downloadCsv(`Tally_${tag}.xml`, tallyXml(docs, s, range), 'application/xml;charset=utf-8')} icon={<Download size={13} />} className="!py-1.5 !px-3 text-xs">Tally (XML)</Button>}>
                <p className="text-xs text-gray-600 dark:text-gray-400">{register.length} voucher{register.length === 1 ? '' : 's'} · sales into “{s.tally.salesLedger}”, tax into “{s.tally.cgstLedger}”, “{s.tally.sgstLedger}”, “{s.tally.igstLedger}”.</p>
            </CardSection>

            {s.registration === 'regular' ? (
                <CardSection title="GSTR-1 export" hint="CSV files in the GST offline tool’s format, for this period. Check them before filing.">
                    <div className="flex flex-wrap gap-2">
                        {(() => {
                            const files = gstr1(docs, s, range);
                            return GSTR1_SECTIONS.map(([k, label]) => {
                                const rows = files[k].split('\n').length - 1;
                                return (
                                    <Button key={k} type="button" disabled={rows === 0} onClick={() => downloadCsv(`GSTR1_${k}_${tag}.csv`, files[k])} icon={<Download size={13} />} className="!py-1.5 !px-3 text-xs">
                                        {label} ({rows})
                                    </Button>
                                );
                            });
                        })()}
                    </div>
                </CardSection>
            ) : (
                <CardSection title="Returns"><p className="text-sm text-gray-600 dark:text-gray-400">Composition / unregistered: no GSTR-1. Use the sales register for CMP-08 and GSTR-4.</p></CardSection>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CardSection title="Money owed to you">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1 text-center">
                        {recv.buckets.map(x => (
                            <div key={x.label} className="neu-inset rounded-lg p-1.5">
                                <p className="text-[9px] uppercase tracking-wider text-gray-600 dark:text-gray-400">{x.label}</p>
                                <p className="text-[11px] font-medium text-gray-900 dark:text-white truncate">{rupeesText(x.amount)}</p>
                            </div>
                        ))}
                    </div>
                    {recv.rows.slice(0, 8).map(r => (
                        <button key={r.doc.id} type="button" onClick={() => onOpen(r.doc.id)} className="w-full flex justify-between text-xs text-left">
                            <span className="text-gray-700 dark:text-gray-300 truncate">{r.doc.number} · {r.doc.party.name}{r.late > 0 ? ` · ${r.late} days late` : ''}</span>
                            <span className="text-gray-900 dark:text-white shrink-0">{rupeesText(r.due)}</span>
                        </button>
                    ))}
                    {recv.rows.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">Nothing outstanding.</p>}
                </CardSection>

                <CardSection title="Goods out on challan" hint={`Proformas this period: ${conv.sent}, converted ${conv.converted} (${conv.pct}%).`}>
                    {challans.map(c => (
                        <button key={c.doc.id} type="button" onClick={() => onOpen(c.doc.id)} className="w-full flex justify-between items-center gap-2 text-xs text-left">
                            <span className="text-gray-700 dark:text-gray-300 truncate">{c.doc.number} · {c.doc.party.name} · {c.out} out{c.doc.returnBy ? ` · back by ${shortDate(c.doc.returnBy)}` : ''}</span>
                            {c.overdue && <StatusBadge text="Overdue" />}
                        </button>
                    ))}
                    {challans.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No goods out on approval, exhibition or job work.</p>}
                </CardSection>
            </div>
        </div>
    );
}

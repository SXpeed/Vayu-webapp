import type { Expense, ExpenseInput } from '../expenseRules';
import { apiCall as call } from './apiClient';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const expenseService = {
    /** Your expenses in the month starting on this YYYY-MM-01. */
    async month(month: string): Promise<Expense[]> {
        return (await call<{ expenses: Expense[] }>(`/expenses?month=${month}`)).expenses;
    },
    create(e: ExpenseInput): Promise<Expense> {
        return call<Expense>('/expenses', json('POST', e));
    },
    update(id: string, e: ExpenseInput): Promise<Expense> {
        return call<Expense>(`/expenses/${id}`, json('PUT', e));
    },
    async remove(id: string): Promise<void> {
        await call(`/expenses/${id}`, { method: 'DELETE' });
    },
};

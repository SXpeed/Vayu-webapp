import fs from 'node:fs';
import path from 'node:path';

function walk(d) {
    let totalLines = 0;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
            totalLines += walk(fullPath);
        } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            totalLines += content.split('\n').length;
        }
    }
    return totalLines;
}

const root = path.resolve(process.argv[2] || '.');
console.log(`Total lines: ${walk(root)}`);
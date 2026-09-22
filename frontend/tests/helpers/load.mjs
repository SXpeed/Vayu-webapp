// Bundle a TypeScript module (and whatever it imports) with esbuild and
// import it, so node:test files can exercise real source without a build step.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function load(relativeToFrontend) {
    const entry = fileURLToPath(new URL(`../../${relativeToFrontend}`, import.meta.url));
    const out = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        write: false,
        logLevel: 'silent',
    });
    const code = out.outputFiles[0].text;
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** Delete only an explicitly allocated playbook fixture below the real OS temp root. */
export function removeTempFixture(root: string): void {
    if (!fs.existsSync(root))
        return;
    const temp = fs.realpathSync(os.tmpdir()), resolved = fs.realpathSync(root);
    if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith("playbook-") || resolved !== path.resolve(root)) {
        throw new Error(`Refusing fixture cleanup outside its allocated temp directory: ${resolved}`);
    }
    const makeWritable = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                makeWritable(file);
            else
                fs.chmodSync(file, 0o600);
        }
    };
    makeWritable(resolved);
    fs.rmSync(resolved, { recursive: true, force: true });
}

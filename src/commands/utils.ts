import * as path from "node:path";

export function targetLabel(filePath: string): string {
	const dir = path.basename(path.dirname(filePath));
	return `${dir}/${path.basename(filePath)}`;
}

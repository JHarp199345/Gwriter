import type { RetrievalMode, RetrievalQuery } from './retrieval/types';

export interface QueryBuilderInput {
	mode: RetrievalMode;
	activeFilePath?: string;
	primaryText: string;
	directorNotes?: string;
	sceneSummary?: string;
	characterNames?: string[];
}

export class QueryBuilder {
	build(input: QueryBuilderInput): RetrievalQuery {
		const parts: string[] = [];
		const push = (label: string, value: string | undefined) => {
			const v = (value ?? '').trim();
			if (!v) return;
			parts.push(`${label}:\n${v}`);
		};

		push('Primary text', input.primaryText);
		push('Director notes', input.directorNotes);
		push('Scene summary', input.sceneSummary);

		return {
			text: parts.join('\n\n'),
			activeFilePath: input.activeFilePath,
			mode: input.mode,
			hints: {
				characters: input.characterNames?.filter((n) => typeof n === 'string' && n.trim().length > 0)
			}
		};
	}
}



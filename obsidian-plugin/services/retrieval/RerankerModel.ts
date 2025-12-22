export interface RerankResult {
	score: number; // 0..1
}

export interface CpuRerankerModel {
	readonly id: string;
	rerankPair(query: string, document: string): Promise<RerankResult>;
}



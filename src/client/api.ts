import type { SessionMetadata } from "../shared/types";

export interface ApiClientOptions {
	apiUrl: string;
	token: string;
}

export interface SessionListItem {
	id: string;
	label: string | null;
	sourceMachine: string | null;
	sourceCwd: string;
	sourceUserDir: string;
	sizeBytes: number;
	metadata: SessionMetadata | null;
	createdAt: string;
	tags: string[];
}

export interface UploadInitResponse {
	uploadUrl: string;
	sessionRecordId: string;
}

export interface DownloadResponse {
	downloadUrl: string;
	session: {
		id: string;
		sourceCwd: string;
		sourceUserDir: string;
		sourceMachine: string | null;
		metadata: SessionMetadata | null;
	};
}

/**
 * HTTP client for the CodeTeleport backend API.
 */
export class CodeTeleportClient {
	constructor(_options: ApiClientOptions) {
		throw new Error("not implemented");
	}

	async register(_email: string, _password: string): Promise<{ token: string; user: { id: string; email: string } }> {
		throw new Error("not implemented");
	}

	async login(_email: string, _password: string): Promise<{ token: string; user: { id: string; email: string } }> {
		throw new Error("not implemented");
	}

	async createApiToken(_name: string, _expiresIn?: string): Promise<{ token: string; id: string }> {
		throw new Error("not implemented");
	}

	async listSessions(_params?: { machine?: string; tag?: string; limit?: number }): Promise<{
		sessions: SessionListItem[];
		total: number;
	}> {
		throw new Error("not implemented");
	}

	async initiateUpload(_data: {
		sessionId: string;
		sourceMachine: string;
		sourceCwd: string;
		sourceUserDir: string;
		sizeBytes: number;
		checksum: string;
		metadata: SessionMetadata;
		tags?: string[];
		label?: string;
	}): Promise<UploadInitResponse> {
		throw new Error("not implemented");
	}

	async confirmUpload(_sessionId: string): Promise<void> {
		throw new Error("not implemented");
	}

	async getDownloadUrl(_sessionId: string): Promise<DownloadResponse> {
		throw new Error("not implemented");
	}

	async deleteSession(_sessionId: string): Promise<void> {
		throw new Error("not implemented");
	}

	async uploadBundle(_presignedUrl: string, _filePath: string): Promise<void> {
		throw new Error("not implemented");
	}

	async downloadBundle(_presignedUrl: string, _outputPath: string): Promise<void> {
		throw new Error("not implemented");
	}
}

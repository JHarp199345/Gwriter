import { 
    Violation, 
    AuditResult, 
    PatchOp, 
    ChapterState, 
    StageResult 
} from './Schemas';

/**
 * Typed events for the Relay Generation system.
 */
export type RelayEvents = {
    'run:start': { runId: string, chapterId: string };
    'run:end': { runId: string, totalWords: number };
    'run:error': { runId: string, error: string };
    
    'stage:start': { runId: string, stageId: string, type: string };
    'stage:progress': { runId: string, stageId: string, message: string };
    'stage:end': { runId: string, stageId: string, result: StageResult };
    
    'chunk:buffer:update': { runId: string, chunkId: string, content: string, tokens: string[] };
    'chunk:committed': { runId: string, chunkId: string, content: string, path: string };
    
    'state:updated': { runId: string, chapterId: string, diffSummary: string };
    
    'audit:violations': { runId: string, chunkId: string, violations: Violation[], overallSeverity: number };
    'repair:applied': { runId: string, chunkId: string, patches: PatchOp[] };
    
    'control:paused': { runId: string };
    'control:resumed': { runId: string };
    'control:aborted': { runId: string };
};

export type RelayEventName = keyof RelayEvents;
export type RelayEventHandler<T extends RelayEventName> = (data: RelayEvents[T]) => void;

/**
 * Centralized Event Bus for the Relay Generation system.
 * Ensures typed communication between the SequentialGenerator and UI components.
 */
export class RelayEventBus {
    private listeners: { [K in RelayEventName]?: RelayEventHandler<K>[] } = {};

    /**
     * Subscribe to an event.
     */
    on<T extends RelayEventName>(event: T, handler: RelayEventHandler<T>) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event]!.push(handler);
    }

    /**
     * Unsubscribe from an event.
     */
    off<T extends RelayEventName>(event: T, handler: RelayEventHandler<T>) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event]!.filter(h => h !== handler);
    }

    /**
     * Emit an event with typed data.
     */
    emit<T extends RelayEventName>(event: T, data: RelayEvents[T]) {
        if (!this.listeners[event]) return;
        this.listeners[event]!.forEach(handler => handler(data));
    }
}

// Global instance for convenience, though instances can be created per run if needed.
export const relayEventBus = new RelayEventBus();


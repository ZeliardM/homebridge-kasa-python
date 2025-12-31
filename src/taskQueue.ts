import type { Logging } from 'homebridge';

export class TaskQueue {
  private queue: (() => Promise<void>)[] = [];
  private running: boolean = false;
  private log: Logging;
  private resolveEmptyQueue: (() => void) | null = null;
  private isShuttingDownRef: () => boolean;

  constructor(log: Logging, isShuttingDownRef: () => boolean) {
    this.log = log;
    this.isShuttingDownRef = isShuttingDownRef;
  }

  public addTask(task: () => Promise<void>): void {
    if (this.isShuttingDownRef && this.isShuttingDownRef()) {
      this.log.warn('TaskQueue: Attempted to add a task after shutdown started. Task rejected.');
      return;
    }
    this.queue.push(task);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          this.log.error('Error processing task:', error);
        }
      }
    }
    this.running = false;
    if (this.resolveEmptyQueue) {
      this.resolveEmptyQueue();
      this.resolveEmptyQueue = null;
    }
  }

  public async waitForEmptyQueue(): Promise<void> {
    if (this.queue.length === 0 && !this.running) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.resolveEmptyQueue = resolve;
    });
  }
}
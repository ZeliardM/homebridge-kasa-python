import type { Logging } from 'homebridge';

export class TaskQueue<T = void> {
  private queue: (() => Promise<T>)[] = [];
  private running: boolean = false;
  private log: Logging;

  constructor(log: Logging) {
    this.log = log;
  }

  public addTask(task: () => Promise<T>): void {
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
  }
}
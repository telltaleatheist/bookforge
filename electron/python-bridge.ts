import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';

interface PythonProcess {
  id: string;
  script: string;
  process: ChildProcess;
  startTime: number;
  status: 'running' | 'completed' | 'error';
}

interface PythonCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * PythonBridge - Manages Python child processes for BookForge
 *
 * Supports two modes:
 * 1. call() - One-shot call: spawn, get result, exit
 * 2. spawn() - Long-running process with streaming output
 */
export class PythonBridge extends EventEmitter {
  private pythonPath: string;
  private processes: Map<string, PythonProcess> = new Map();
  private processCounter = 0;

  constructor(pythonScriptsPath: string) {
    super();
    this.pythonPath = pythonScriptsPath;
  }

  /**
   * Make a one-shot call to a Python script
   * Script should read JSON from stdin and write JSON to stdout
   */
  async call(script: string, method: string, args: unknown[]): Promise<PythonCallResult> {
    return new Promise((resolve) => {
      const scriptPath = path.join(this.pythonPath, script);
      const proc = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            resolve({ success: true, data: result });
          } catch {
            resolve({ success: true, data: stdout });
          }
        } else {
          resolve({ success: false, error: stderr || `Process exited with code ${code}` });
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      // Send request as JSON to stdin
      const request = JSON.stringify({ method, args });
      proc.stdin?.write(request);
      proc.stdin?.end();
    });
  }

  /**
   * Spawn a long-running Python process
   * Returns process ID for tracking
   */
  spawn(script: string, args: string[] = []): string {
    const id = `py_${++this.processCounter}_${Date.now()}`;
    const scriptPath = path.join(this.pythonPath, script);

    const proc = spawn('python3', [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pythonProcess: PythonProcess = {
      id,
      script,
      process: proc,
      startTime: Date.now(),
      status: 'running',
    };

    this.processes.set(id, pythonProcess);

    proc.stdout?.on('data', (data) => {
      this.emit('stdout', { id, data: data.toString() });
    });

    proc.stderr?.on('data', (data) => {
      this.emit('stderr', { id, data: data.toString() });
    });

    proc.on('close', (code) => {
      const p = this.processes.get(id);
      if (p) {
        p.status = code === 0 ? 'completed' : 'error';
      }
      this.emit('close', { id, code });
    });

    proc.on('error', (err) => {
      const p = this.processes.get(id);
      if (p) {
        p.status = 'error';
      }
      this.emit('error', { id, error: err.message });
    });

    return id;
  }

  /**
   * Send data to a running process's stdin
   */
  send(processId: string, data: string): boolean {
    const proc = this.processes.get(processId);
    if (proc && proc.status === 'running') {
      proc.process.stdin?.write(data);
      return true;
    }
    return false;
  }

  /**
   * Kill a specific process
   */
  kill(processId: string): boolean {
    const proc = this.processes.get(processId);
    if (proc && proc.status === 'running') {
      proc.process.kill('SIGTERM');
      proc.status = 'completed';
      return true;
    }
    return false;
  }

  /**
   * Kill all running processes
   */
  killAll(): void {
    for (const [id, proc] of this.processes) {
      if (proc.status === 'running') {
        proc.process.kill('SIGTERM');
        proc.status = 'completed';
      }
    }
    this.processes.clear();
  }

  /**
   * List all processes with their status
   */
  listProcesses(): Array<{ id: string; script: string; status: string; runtime: number }> {
    const now = Date.now();
    return Array.from(this.processes.values()).map((p) => ({
      id: p.id,
      script: p.script,
      status: p.status,
      runtime: now - p.startTime,
    }));
  }

  /**
   * Clean up completed processes from memory
   */
  cleanup(): void {
    for (const [id, proc] of this.processes) {
      if (proc.status !== 'running') {
        this.processes.delete(id);
      }
    }
  }
}

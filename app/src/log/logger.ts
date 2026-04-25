import fs from 'node:fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { EventLog, LogLevel } from '../persistence/eventLog.js';

export interface LogCall {
  source: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AppLogger {
  info(c: LogCall): void;
  warn(c: LogCall): void;
  error(c: LogCall): void;
}

export interface CreateLoggerOpts {
  eventLog: EventLog;
  logDir: string;
  consoleLevel?: 'info' | 'warn' | 'error' | 'silent';
}

export function createLogger(opts: CreateLoggerOpts): AppLogger {
  if (!fs.existsSync(opts.logDir)) fs.mkdirSync(opts.logDir, { recursive: true });

  const transports: winston.transport[] = [
    new DailyRotateFile({
      dirname: opts.logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      level: 'info',
    }),
  ];
  if (opts.consoleLevel !== 'silent') {
    transports.push(new winston.transports.Console({ level: opts.consoleLevel ?? 'info' }));
  }

  const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports,
  });

  const emit = (level: LogLevel, c: LogCall) => {
    winstonLogger.log({
      level: level === 'warn' ? 'warn' : level,
      message: c.message,
      source: c.source,
      eventType: c.eventType,
      metadata: c.metadata,
    });
    opts.eventLog.append({
      level,
      source: c.source,
      eventType: c.eventType,
      message: c.message,
      metadata: c.metadata,
    });
  };

  return {
    info: (c) => emit('info', c),
    warn: (c) => emit('warn', c),
    error: (c) => emit('error', c),
  };
}

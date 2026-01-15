import winston from 'winston';
import type TransportStream from 'winston-transport';
import { mkdirSync } from 'fs';
import { join } from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  if (Object.keys(metadata).length > 0 && metadata.stack === undefined) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  if (metadata.stack) {
    msg += `\n${metadata.stack}`;
  }

  return msg;
});

const consoleTransport = new winston.transports.Console({
  format: combine(
    colorize(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
});

const DEFAULT_LOG_DIR = 'logs';

const createFileTransports = (dir: string): TransportStream[] => {
  mkdirSync(dir, { recursive: true });
  return [
    new winston.transports.File({
      filename: join(dir, 'error.log'),
      level: 'error',
      maxsize: 1048576, // 1MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: join(dir, 'combined.log'),
      maxsize: 1048576, // 1MB
      maxFiles: 3,
    }),
  ];
};

let currentLogDir = DEFAULT_LOG_DIR;
let fileTransports = createFileTransports(DEFAULT_LOG_DIR);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [consoleTransport, ...fileTransports],
});

export function configureLogDirectory(dir: string): void {
  if (!dir || dir === currentLogDir) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  const newTransports = createFileTransports(dir);

  for (const transport of fileTransports) {
    logger.remove(transport);
    if (typeof (transport as { close?: () => void }).close === 'function') {
      (transport as { close: () => void }).close();
    }
  }

  for (const transport of newTransports) {
    logger.add(transport);
  }

  fileTransports = newTransports;
  currentLogDir = dir;
}

export default logger;

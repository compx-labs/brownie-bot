#!/usr/bin/env node
/**
 * Filters zs-proxy stdout/stderr so CDN HTML gateway pages in err_body=
 * become short ZeroSignal summaries (same idea as brownie-bot sanitizeErrorText).
 */
import { createInterface } from "node:readline";

import { sanitizeErrorText } from "../dist/util/errors.js";

function sanitizeZsLogLine(line) {
  if (!line.includes("err_body=") || !looksLikeHtml(line)) {
    return line;
  }
  const prefix = line.replace(/\s*err_body=[\s\S]*$/, "").trimEnd();
  const status = /\bstatus=(\d{3})\b/.exec(line)?.[1];
  const bodyStart = line.indexOf("err_body=");
  const body = line.slice(bodyStart).replace(/^err_body=/, "").replace(/^"/, "").replace(/"$/, "");
  const summary = sanitizeErrorText(status ? `${status} ${body}` : body, {
    maxLength: 200,
  });
  return `${prefix} err_body="${summary.replaceAll('"', "'")}"`;
}

function looksLikeHtml(text) {
  return /<!DOCTYPE\s+html/i.test(text) || /<\s*html\b/i.test(text);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  process.stdout.write(`${sanitizeZsLogLine(line)}\n`);
});
rl.on("close", () => {
  process.stdout.write("");
});

/**
 * Test setup for apps/web: configure DOM environment using jsdom
 * so tests have access to window, localStorage, document, etc.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url: "http://localhost:3000",
  pretendToBeVisual: true,
});

const g = globalThis as Record<string, unknown>;

// Core DOM globals
g.window = dom.window as unknown;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.location = dom.window.location;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
g.history = dom.window.history;

// DOM classes needed by @testing-library/react
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.HTMLAnchorElement = dom.window.HTMLAnchorElement;
g.HTMLFormElement = dom.window.HTMLFormElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.NodeList = dom.window.NodeList;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.InputEvent = dom.window.InputEvent;
g.FocusEvent = dom.window.FocusEvent;
g.PointerEvent = dom.window.PointerEvent;
g.DragEvent = dom.window.DragEvent;
g.ClipboardEvent = dom.window.ClipboardEvent;
g.MutationObserver = dom.window.MutationObserver;
g.IntersectionObserver = dom.window.IntersectionObserver || class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.ResizeObserver = dom.window.ResizeObserver || class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.URL = dom.window.URL;
g.URLSearchParams = dom.window.URLSearchParams;
g.Blob = dom.window.Blob;
g.File = dom.window.File;
g.FileReader = dom.window.FileReader;
g.FormData = dom.window.FormData;
g.Storage = dom.window.Storage;
g.Headers = dom.window.Headers || globalThis.Headers;
g.Request = dom.window.Request || globalThis.Request;
g.Response = dom.window.Response || globalThis.Response;
g.fetch = globalThis.fetch; // keep bun's native fetch
g.TextEncoder = globalThis.TextEncoder;
g.TextDecoder = globalThis.TextDecoder;

// Range for @testing-library
g.Range = dom.window.Range;

// CSS
g.CSSStyleDeclaration = dom.window.CSSStyleDeclaration;
g.CSSStyleSheet = dom.window.CSSStyleSheet;

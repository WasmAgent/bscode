import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileTree } from "./FileTree";

describe("FileTree", () => {
  it("renders an empty-state message when no files", () => {
    const { container } = render(<FileTree files={[]} />);
    expect(container.textContent).toMatch(/No files yet/i);
  });

  it("renders flat files at root level", () => {
    const { container } = render(
      <FileTree files={[{ path: "README.md" }, { path: "package.json" }]} />
    );
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("package.json");
  });

  it("groups files into nested directories", () => {
    const { container } = render(
      <FileTree
        files={[
          { path: "src/components/Button.tsx" },
          { path: "src/components/Modal.tsx" },
          { path: "src/main.tsx" },
        ]}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("src");
    expect(text).toContain("components");
    expect(text).toContain("Button.tsx");
    expect(text).toContain("Modal.tsx");
    expect(text).toContain("main.tsx");
  });

  it("shows + badge on created files", () => {
    const { container } = render(<FileTree files={[{ path: "new.ts", created: true }]} />);
    expect(container.textContent).toContain("+");
  });

  it("shows M badge on modified files (without + badge)", () => {
    const { container } = render(<FileTree files={[{ path: "edited.ts", modified: true }]} />);
    expect(container.textContent).toContain("M");
  });
});

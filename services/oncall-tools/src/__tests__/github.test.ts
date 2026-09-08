import { describe, expect, it } from "vitest";
import { extractImageLine, replaceImageLine } from "../github.js";

const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-api
spec:
  template:
    spec:
      containers:
        - name: demo-api
          image: registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0
          ports:
            - containerPort: 8080
`;

describe("replaceImageLine", () => {
  it("replaces the exact image line, preserving indentation", () => {
    const next = replaceImageLine(yaml, "registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0", "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0");
    expect(next).toBeDefined();
    expect(next).toContain("          image: registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0");
    expect(next).not.toContain(":1.0.0");
    // Rest of the file is untouched.
    expect(next).toContain("containerPort: 8080");
  });

  it("returns undefined when the from-image line is not present (drift)", () => {
    const next = replaceImageLine(yaml, "registry.rosenvall.se/carnufex/oncall-demo-api:9.9.9", "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0");
    expect(next).toBeUndefined();
  });

  it("does not touch other image-shaped lines with a different value", () => {
    const other = "  image: registry.rosenvall.se/carnufex/other-service:2.0.0\n" + yaml;
    const next = replaceImageLine(other, "registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0", "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0");
    expect(next).toContain("other-service:2.0.0");
    expect(next).toContain("oncall-demo-api:1.1.0");
  });
});

describe("extractImageLine", () => {
  it("extracts the image reference", () => {
    expect(extractImageLine(yaml)).toBe("registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0");
  });

  it("returns undefined when there is no image line", () => {
    expect(extractImageLine("apiVersion: v1\nkind: ConfigMap\n")).toBeUndefined();
  });
});

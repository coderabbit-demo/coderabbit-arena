import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATES,
  escapeHtml,
  expressionsIn,
  render,
  renderHtml,
  TemplateError,
  validateTemplate,
} from "./templates";

const ctx = {
  booking: {
    id: "b1",
    bookedBy: "Ada",
    start: "2026-10-01T09:00:00.000Z",
    end: "2026-10-01T10:30:00.000Z",
  },
  resource: { name: "Boardroom" },
  tags: ["vip", "catering"],
  empty: "",
};

describe("render", () => {
  it("substitutes simple paths", () => {
    expect(render("Hi {{ booking.bookedBy }} ({{resource.name}})", ctx)).toBe(
      "Hi Ada (Boardroom)",
    );
  });

  it("calls helpers", () => {
    expect(render("{{ upper(resource.name) }}", ctx)).toBe("BOARDROOM");
    expect(render("{{ minutesBetween(booking.start, booking.end) }}", ctx)).toBe("90");
    expect(render("{{ join(tags, ' + ') }}", ctx)).toBe("vip + catering");
    expect(render("{{ fallback(empty, 'n/a') }}", ctx)).toBe("n/a");
  });

  it("formats dates", () => {
    expect(render("{{ formatDate(booking.start) }}", ctx)).toBe(
      "Thu, 01 Oct 2026 09:00:00 GMT",
    );
    expect(render("{{ formatDate('garbage') }}", ctx)).toBe("garbage");
  });

  it("renders undefined and null as empty strings", () => {
    expect(render("[{{ booking.missing }}]", ctx)).toBe("[]");
    expect(render("[{{ null }}]", ctx)).toBe("[]");
  });

  it("serialises objects as JSON", () => {
    expect(render("{{ resource }}", ctx)).toBe('{"name":"Boardroom"}');
  });

  it("supports arbitrary expressions", () => {
    expect(render("{{ tags.length > 1 ? 'many' : 'one' }}", ctx)).toBe("many");
    expect(render("{{ 2 + 2 }}", ctx)).toBe("4");
  });

  it("leaves text without expressions untouched", () => {
    expect(render("plain text", ctx)).toBe("plain text");
  });
});

describe("renderHtml", () => {
  it("wraps the body and converts newlines", () => {
    const html = renderHtml("Hi {{ booking.bookedBy }}\nBye", ctx);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Hi Ada<br>\nBye");
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("validateTemplate / expressionsIn", () => {
  it("accepts valid templates", () => {
    expect(() => validateTemplate("{{ a }} and {{ b.c }}")).not.toThrow();
  });

  it("rejects syntax errors", () => {
    expect(() => validateTemplate("{{ a +* }}")).toThrow(TemplateError);
  });

  it("lists expressions in order", () => {
    expect(expressionsIn("{{ one }} x {{ two.three }}")).toEqual(["one", "two.three"]);
  });
});

describe("DEFAULT_TEMPLATES", () => {
  it("all compile", () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(() => validateTemplate(t.subject)).not.toThrow();
      expect(() => validateTemplate(t.body)).not.toThrow();
    }
  });

  it("cover the events that notify bookers", () => {
    const events = DEFAULT_TEMPLATES.map((t) => t.event);
    expect(events).toContain("booking.created");
    expect(events).toContain("booking.cancelled");
    expect(events).toContain("invite.created");
  });
});

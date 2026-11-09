import { enrichInteractionSpan } from './interaction-telemetry';

function fakeSpan() {
  return { updateName: vi.fn(), setAttribute: vi.fn() };
}

describe('enrichInteractionSpan', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('never prevents the span (the hook is an enrichment seam, despite its name)', () => {
    expect(enrichInteractionSpan(document.createElement('button'), fakeSpan() as never)).toBe(
      false,
    );
  });

  it('names the span from data-track-event on an ancestor (a submit targets the form)', () => {
    const form = document.createElement('form');
    form.setAttribute('data-track-event', 'save-greeting');
    const button = document.createElement('button');
    form.appendChild(button);
    document.body.appendChild(form);

    const span = fakeSpan();
    enrichInteractionSpan(form, span as never);

    expect(span.updateName).toHaveBeenCalledWith('interaction save-greeting');
    expect(span.setAttribute).toHaveBeenCalledWith('app.interaction.name', 'save-greeting');
  });

  it('describes unnamed targets by tag#id', () => {
    const button = document.createElement('button');
    button.id = 'save';
    const span = fakeSpan();
    enrichInteractionSpan(button, span as never);
    expect(span.updateName).not.toHaveBeenCalled();
    expect(span.setAttribute).toHaveBeenCalledWith('app.interaction.target', 'button#save');
  });

  it('falls back to a text snippet for anonymous targets', () => {
    const button = document.createElement('button');
    button.textContent = 'Save the greeting';
    const span = fakeSpan();
    enrichInteractionSpan(button, span as never);
    expect(span.setAttribute).toHaveBeenCalledWith(
      'app.interaction.target',
      'button "Save the greeting"',
    );
  });

  it('puts the outcome mark on the span and names it from the first mark', () => {
    const button = document.createElement('button');
    button.setAttribute('data-qits-outcome', 'create-work-item:created create-work-item:refused');
    const icon = document.createElement('span');
    button.appendChild(icon);
    document.body.appendChild(button);

    const span = fakeSpan();
    enrichInteractionSpan(icon, span as never);

    expect(span.updateName).toHaveBeenCalledWith('interaction create-work-item');
    expect(span.setAttribute).toHaveBeenCalledWith('app.interaction.name', 'create-work-item');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'app.interaction.outcome',
      'create-work-item:created create-work-item:refused',
    );
  });

  it('lets data-track-event name the span over an outcome mark, and keeps the mark', () => {
    const form = document.createElement('form');
    form.setAttribute('data-track-event', 'save-greeting');
    const link = document.createElement('a');
    link.setAttribute('data-qits-outcome', 'open-project:opened');
    form.appendChild(link);
    document.body.appendChild(form);

    const span = fakeSpan();
    enrichInteractionSpan(link, span as never);

    expect(span.updateName).toHaveBeenCalledOnce();
    expect(span.updateName).toHaveBeenCalledWith('interaction save-greeting');
    expect(span.setAttribute).toHaveBeenCalledWith('app.interaction.name', 'save-greeting');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'app.interaction.outcome',
      'open-project:opened',
    );
  });

  it('ignores an empty outcome mark', () => {
    const button = document.createElement('button');
    button.setAttribute('data-qits-outcome', '');
    const span = fakeSpan();
    enrichInteractionSpan(button, span as never);
    expect(span.updateName).not.toHaveBeenCalled();
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'app.interaction.outcome',
      expect.anything(),
    );
  });
});

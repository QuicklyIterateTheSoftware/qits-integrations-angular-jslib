import { visibleDataMarks } from './visible-data-marks';

/** Which data marks a shot shows: measured on the live DOM, so in a real browser. */

const byId = (id: string) => document.getElementById(id) as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibleDataMarks', () => {
  it('resolves source and item from the closest ancestor (itself included); every marked element gets its own entry', () => {
    const SOURCE = 'qits-projects-service#listProjects';
    document.body.innerHTML =
      `<section id="shot" data-qits-source="${SOURCE}" style="width:300px;height:200px">` +
      '<div data-qits-item="id=1"><span data-qits-field="name">Demo</span></div>' +
      '<div data-qits-item="id=2"><span data-qits-field="name">Other</span></div>' +
      '</section>';
    expect(visibleDataMarks(byId('shot'), document)).toEqual([
      // The source container is itself a marked element: its own entry, no item or field.
      { source: SOURCE, item: null, field: null, derived: [] },
      // Nulls first: an item container (no field of its own) sorts before its field.
      { source: SOURCE, item: 'id=1', field: null, derived: [] },
      { source: SOURCE, item: 'id=1', field: 'name', derived: [] },
      { source: SOURCE, item: 'id=2', field: null, derived: [] },
      { source: SOURCE, item: 'id=2', field: 'name', derived: [] },
    ]);
  });

  it('deduplicates identical entries', () => {
    document.body.innerHTML =
      '<section id="shot" style="width:300px;height:200px">' +
      '<p data-qits-field="name">A</p>' +
      '<p data-qits-field="name">B</p>' +
      '<p data-qits-derived="a.b">C</p>' +
      '<p data-qits-derived="a.b">D</p>' +
      '</section>';
    expect(visibleDataMarks(byId('shot'), document)).toEqual([
      { source: null, item: null, field: null, derived: ['a.b'] },
      { source: null, item: null, field: 'name', derived: [] },
    ]);
  });

  it('leaves out a mark that is display:none, visibility:hidden, hidden, zero-size or outside the target', () => {
    document.body.innerHTML =
      '<section id="shot" style="position:relative;width:300px;height:200px">' +
      '<p data-qits-field="shown">Shown</p>' +
      '<p data-qits-field="display-none" style="display:none">x</p>' +
      '<div style="display:none"><p data-qits-field="display-none-parent">x</p></div>' +
      '<p data-qits-field="invisible" style="visibility:hidden">x</p>' +
      '<p data-qits-field="hidden" hidden>x</p>' +
      '<div hidden style="display:block"><p data-qits-field="hidden-parent">x</p></div>' +
      '<span data-qits-field="zero-size" style="display:inline-block;width:0;height:0"></span>' +
      '<p data-qits-field="outside" style="position:absolute;left:400px;top:0">x</p>' +
      '</section>';
    expect(visibleDataMarks(byId('shot'), document)).toEqual([
      { source: null, item: null, field: 'shown', derived: [] },
    ]);
  });

  it('takes the page’s scroll area for a page shot, below the fold included', () => {
    document.body.innerHTML =
      '<div style="height:3000px"></div>' +
      '<p data-qits-field="more">More</p>' +
      '<p data-qits-field="off-page" style="position:absolute;left:-500px;top:0">x</p>' +
      '<p data-qits-field="closed" style="display:none">x</p>';
    expect(visibleDataMarks(null, document)).toEqual([
      { source: null, item: null, field: 'more', derived: [] },
    ]);
  });

  it('resolves a join element carrying its own source, item and field to itself, with or without a wrapping target', () => {
    document.body.innerHTML =
      '<div id="shot" style="width:300px;height:200px">' +
      '<span id="join" data-qits-source="qits-projects-service#getOwner" ' +
      'data-qits-item="id=7" data-qits-field="name">Owner</span>' +
      '</div>';
    const expected = [
      { source: 'qits-projects-service#getOwner', item: 'id=7', field: 'name', derived: [] },
    ];
    expect(visibleDataMarks(byId('shot'), document)).toEqual(expected);
    // `closest` includes the element itself, so asking for the join element alone is the same.
    expect(visibleDataMarks(byId('join'), document)).toEqual(expected);
  });

  it('parses derived as the space-separated input paths, empty without the attribute', () => {
    document.body.innerHTML =
      '<section id="shot" style="width:300px;height:200px">' +
      '<p data-qits-derived="a.b  c.d">computed</p>' +
      '<p data-qits-field="plain">plain</p>' +
      '</section>';
    expect(visibleDataMarks(byId('shot'), document)).toEqual([
      { source: null, item: null, field: null, derived: ['a.b', 'c.d'] },
      { source: null, item: null, field: 'plain', derived: [] },
    ]);
  });
});

import { visibleTriggers } from './visible-triggers';

/** Which outcome triggers a shot shows: measured on the live DOM, so in a real browser. */

const byId = (id: string) => document.getElementById(id) as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibleTriggers', () => {
  it('lists the visible marks in the target, split, deduplicated and sorted', () => {
    document.body.innerHTML =
      '<section id="shot" data-qits-outcome="page:shown" style="width:300px;height:200px">' +
      '<button data-qits-outcome="create:refused create:created">Create</button>' +
      '<a data-qits-outcome="create:created" href="#">Again</a></section>' +
      '<button data-qits-outcome="elsewhere:outside">Outside the target</button>';
    expect(visibleTriggers(byId('shot'), document)).toEqual([
      'create:created',
      'create:refused',
      'page:shown',
    ]);
  });

  it('leaves out a mark that is display:none, visibility:hidden, hidden, zero-size or outside the target', () => {
    document.body.innerHTML =
      '<section id="shot" style="position:relative;width:300px;height:200px">' +
      '<button data-qits-outcome="menu:shown">Shown</button>' +
      '<button data-qits-outcome="menu:display-none" style="display:none">x</button>' +
      '<div style="display:none"><button data-qits-outcome="menu:display-none-parent">x</button></div>' +
      '<button data-qits-outcome="menu:invisible" style="visibility:hidden">x</button>' +
      '<button data-qits-outcome="menu:hidden" hidden>x</button>' +
      // `hidden` on an ancestor whose display a stylesheet overrode still hides the mark.
      '<div hidden style="display:block"><button data-qits-outcome="menu:hidden-parent">x</button></div>' +
      '<span data-qits-outcome="menu:zero-size" style="display:inline-block;width:0;height:0"></span>' +
      '<button data-qits-outcome="menu:outside" style="position:absolute;left:400px;top:0">x</button>' +
      '</section>';
    expect(visibleTriggers(byId('shot'), document)).toEqual(['menu:shown']);
  });

  it('takes the page’s scroll area for a page shot, below the fold included', () => {
    document.body.innerHTML =
      '<div style="height:3000px"></div>' +
      '<button data-qits-outcome="list:more">More</button>' +
      '<button data-qits-outcome="list:off-page" style="position:absolute;left:-500px;top:0">x</button>' +
      '<button data-qits-outcome="list:closed" style="display:none">x</button>';
    expect(visibleTriggers(null, document)).toEqual(['list:more']);
  });
});

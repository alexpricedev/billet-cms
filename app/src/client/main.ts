import { Dialog } from "@alexpricedev/billet-dialog";
import { init as initNavMenu } from "@client/components/nav-menu";
import { initializePage } from "@client/page-lifecycle";
import * as ui from "@client/reactive";

// The nav is on every page, so it runs outside the per-data-page registry.
initNavMenu();

// A form carrying `data-confirm` asks before it posts; every other form, and
// every form without JavaScript, posts as it always did.
Dialog.wireForms();

initializePage(document.body.dataset.page);
ui.mount();

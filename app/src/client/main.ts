import { Dialog } from "@alexpricedev/billet-dialog";
import { init as initNavMenu } from "@client/components/nav-menu";
import { init as initPreviewGuard } from "@client/components/preview-guard";
import { initializePage } from "@client/page-lifecycle";
import * as ui from "@client/reactive";

// The nav is on every page, so it runs outside the per-data-page registry.
initNavMenu();

// A form carrying `data-confirm` asks before it posts; every other form, and
// every form without JavaScript, posts as it always did.
Dialog.wireForms();

// Preview posts the last saved revision, so pressing it with unsaved edits on
// screen shows older words. On a CMS form, ask first and offer the save.
initPreviewGuard();

initializePage(document.body.dataset.page);
ui.mount();

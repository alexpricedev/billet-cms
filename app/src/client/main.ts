import { init as initNavMenu } from "@client/components/nav-menu";
import { initializePage } from "@client/page-lifecycle";
import * as ui from "@client/reactive";

// The nav is on every page, so it runs outside the per-data-page registry.
initNavMenu();

initializePage(document.body.dataset.page);
ui.mount();

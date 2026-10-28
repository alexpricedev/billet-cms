# Move a page

As the site owner (Priya) on a laptop, I want to change a page's URL so that it matches our new naming without breaking old links.
Starting from `/about`'s editor, signed in as Priya.
Done when I save `/studio` as a draft and `/about` still serves, then publish: the page lives at `/studio`, `/about` redirects to it, and the redirect shows on the pages list only after the publish.
I expect a saved draft to show `/about` with `/studio` beside it marked "(not published)" in the breadcrumb, and the line under the URL field to say "Publishing moves this page: `/about` will redirect to `/studio`." — the publish dialog names the redirect only while a move is pending, the Draft-saved banner says nothing about redirects, and the Published banner does.

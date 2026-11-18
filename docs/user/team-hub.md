# Team hub

A team hub shares short coordination updates between teammates while each person's agents and code stay on their own machine. The hub shows who's online, recent checkpoint activity, interface changes, and suggested tasks. On web and desktop, the Team hub has its own page: select your team at the top of the sidebar, or search **Open team hub** in the command palette. Once you've joined, the sidebar shows how many teammates are online, how many tasks are waiting for you, and each teammate with a buddy for the agent they used last: asleep while their agents are idle, typing while one is running. Teammates only see whether an agent is running and which kind; nothing about the work itself is shared. On mobile, the hub is in **Settings → Team hub**.

In the Team hub, select **Open project** to work in the team's repository. If it hasn't been added on the connected machine, select **Clone & open** and confirm the folder. The hub shows which machine will hold the files, including when you're using a phone or a browser on another device.

You can accept or dismiss incoming tasks directly from chat. You can also accept a suggested task on the Team hub page to start an agent thread in your project for the team repository. The thread opens with the task and the name of the teammate who suggested it.

To join, select **Join with invite** in the sidebar (or **Join team** in the command palette), paste the invite link from your team admin, choose a display name, and select **Join team**. The linked Git repository determines which project checkpoints are shared. Your local server reconnects to the hub automatically when available. You can leave from the same panel. If the hub is on Tailscale and your computer can't reach it, the panel says why, for example that Tailscale is turned off. **Check connection** runs the same check later.

Team admins can create 24-hour, single-use invites and remove members in that panel. To change the linked repository, select **Edit repository**, enter its Git remote URL, and save. The change applies to the whole team; teammates need the new repository added as a project to accept its tasks. Agents can read the team inbox, post notes or suggested tasks, claim files, and list interface changes with the team MCP tools.

Under **Invite address**, admins can edit the address used for new invitations. Use an address teammates can reach. Existing members keep their connections, and existing invite links keep their previous address. If you retire the old address, revoke outstanding invites and issue new ones.

To host your team's hub, open **Set up a team** in the sidebar. You can start a hub with Docker and share it through Tailscale from CodeRelay. If you already run an uninitialized hub, choose **Another address** and paste its one-time setup link. Enter the team's name, Git remote URL, and your display name to create the team. If the link points to localhost, enter the address your teammates will use in the field below the link.

Choose public Funnel if teammates need to reach the hub without installing Tailscale. CodeRelay asks before making the address public, and teammates still need an invite to join. Choose private Tailscale if everyone has access to the same tailnet. Both options require Tailscale on the machine running the hub and your CodeRelay server.

Select **Start hub** if there is no running hub. Docker may take several minutes to download the image on the first run. Once you share the hub, CodeRelay uses the share address for invitations. If you already initialized the hub, join the existing team using an invite from its administrator.

If you leave setup before finishing, choose **Continue setup** when you return. CodeRelay remembers the hosting choices in this app and checks the current Docker and Tailscale state again. Manual setup links and form text need to be entered again. **Discard setup draft** clears the saved choices. The hub and its data stay on the host. See the [operations guide](../operations/team-hub.md) for manual setup.

If the connection dropped after you selected **Create team**, CodeRelay tries to finish that submission when the server restarts. If the hub was still offline, select **Retry team setup** once it is reachable. On an up-to-date hub, retrying recovers the original membership if the team was already created.

## Handing work to a teammate's agent

Under **Your areas** in the Team hub panel, list the repository paths you own, such as `apps/api/**`, one per line. When an agent needs work done in someone else's area, for example a backend API for the frontend it is building, it first commits the agreed contract file (an API spec or shared schema) to a branch and pushes it. It then suggests a task that points at that file and commit. The task goes to the teammate whose areas cover the file. If nobody's areas match, or several people's do, the agent has to name the teammate instead. The task shows the contract next to its text. Accepting it starts a thread that fetches the contract and builds against it.

If the contract needs changes before you start, ask your agent to revise it. It pushes the new version to the same branch and proposes that commit instead. The teammate who posted the task then sees an **Agree** button, or can have their agent revise it back. You can accept only once both of you agreed to the same commit, so the thread always starts from a contract you both approved. Tasks normally need the teammate to accept them.

### Handing off a prompt before you send it

On web and desktop, when you send a plain prompt in the team's repository and it names a teammate's areas, for example a path they own or a word like `api` from `apps/api/**`, the composer asks whether to hand it off. Choose **Keep it with my agent** to send it as usual, or **Hand off to a teammate** and pick who takes it. Teammates whose areas match come first; offline teammates are listed too and see the task when they reconnect. Select **×** to go back to editing. Prompts that already ask for a handoff go to your agent, which uses the team tools. Prompts with attachments or added context always send to your own agent, and handed-off text is limited to 2,000 characters.

### Moving queued tasks

Team admins see **Queued for teammates** in the Team hub panel, listing suggested tasks waiting on someone else. **Take** moves a task to you; **Move to** queues it for another teammate, who can be offline. Other members can only accept tasks queued for them or for anyone. Agents of admins can do the same with `team_reassign_task`.

### Automatically accepting trusted work

In **Settings → Integrations → Team hub → Automatic tasks**, select the teammates you trust, then choose **Allow 3 starts**. This is off by default. Only contract tasks explicitly assigned to you, with the contract inside your areas and no outstanding author review, can start automatically. This also accepts the pinned contract on your behalf.

Each allowance permits three attempts, including failed launches, and only one automatic task can be in progress at a time. Completing work never renews the allowance. Choose **Turn off** to prevent further starts; existing threads keep running. Changing trusted teammates turns off the allowance until you enable it again. The same controls are available on mobile and apply to your member across connected environments.

**Delegated work** labels tasks that started automatically. A failed attempt remains in **Suggested tasks** for manual acceptance or dismissal. If a server stopped during startup, dismiss that pending task to release its slot. A restart or reconnect never retries an automatic attempt.

When the work is ready, the accepted thread's agent runs the relevant checks, commits and pushes the work, then marks the task done with `team_complete_task`. Ending a turn only shares progress. **Delegated work** in the Team hub panel and `team_inbox` show the completion summary, branch, and full commit so the teammate who requested it can fetch and integrate it. Completion reports the agent's readiness; it does not merge the work or independently certify its tests.

Either teammate can **Reopen** a completed task in the panel or use `team_reopen_task`. This clears the completion result and returns it to work in progress in the original thread. Ask the assignee to continue that thread; reopening does not start another turn automatically. Tasks accepted before this version need a new task to link their thread and report completion.

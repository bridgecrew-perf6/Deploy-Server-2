const { exec } = require("child_process");
const { mkdirSync, existsSync } = require("fs");
const Docker = require("dockerode");
const { getConfig, DockerLogsListener } = require("raraph84-lib");
const Config = getConfig(__dirname + "/..");

class Server {

    /** @type {Server[]} */
    static servers = [];

    /**
     * @param {String} name 
     * @param {String} type 
     */
    constructor(name, type) {

        this.id = Server.servers.length;
        this.name = name;
        this.type = type;

        Server.servers.push(this);
    }

    static async init() {

        const docker = new Docker();
        const containers = await docker.listContainers({ all: true });

        for (const repo of Config.repos) {

            const name = repo.fullname.replace(/[^A-Za-z0-9]/g, "-");

            if (repo.type === "nodejs") {

                const container = containers.find((container) => container.Names[0] === "/" + name);

                if (container) {

                    const server = new NodeJsServer(name, docker.getContainer(container.Id), repo.fullname, repo.githubLogin);

                    if (container.State === "running") {
                        server.listenLogs();
                        server.state = "running";
                    } else {
                        server.container.start();
                    }

                } else {

                    if (!existsSync("/home/hebergs/nodeServers/" + name))
                        mkdirSync("/home/hebergs/nodeServers/" + name);

                    const container = await docker.createContainer({
                        Tty: true,
                        OpenStdin: true,
                        name: name,
                        User: "1000",
                        HostConfig: {
                            Mounts: [
                                {
                                    Target: "/server",
                                    Source: "/home/hebergs/nodeServers/" + name,
                                    Type: "bind"
                                }
                            ],
                            NetworkMode: "host"
                        },
                        WorkingDir: "/server",
                        Env: ["TZ=Europe/Paris"],
                        Image: "node:r18",
                        Cmd: "index.js"
                    });

                    const server = new NodeJsServer(name, container, repo.fullname, repo.githubLogin);

                    server.deploy();
                }

            } else if (repo.type === "website") {

                new WebsiteServer(name, repo.fullname, repo.githubLogin);
            }
        }
    }
}

class WebsiteServer extends Server {

    /**
     * @param {String} name 
     * @param {String} githubRepo 
     * @param {String} githubAuth 
     */
    constructor(name, githubRepo, githubAuth) {

        super(name, "website");

        this.githubRepo = githubRepo;
        this.githubAuth = githubAuth;
    }

    deploy() {
        const command = `${__dirname}/../deployWebsite.sh ${this.name} ${this.githubRepo} ${this.githubAuth}`;
        exec(command).on("close", () => console.log("Deployed " + this.githubRepo + " with command " + command));
    }
}

class NodeJsServer extends Server {

    /**
     * @param {String} name 
     * @param {import("dockerode").Container} container 
     * @param {String} githubRepo 
     * @param {String} githubAuth 
     */
    constructor(name, container, githubRepo, githubAuth) {

        super(name, "nodejs");

        this.lastLogs = [];
        this.container = container;
        this.githubRepo = githubRepo;
        this.githubAuth = githubAuth;
        this.logsListener = null;
        this.state = "stopped";

        require("./gateway").gateway.clients.filter((client) => client.infos.logged).forEach((client) => client.emitEvent("SERVER", { name: this.name, id: this.id }));
    }

    log(line, date) {
        const log = { line, date };
        this.lastLogs.push(log);
        require("./gateway").gateway.clients.filter((client) => client.infos.logged).forEach((client) => client.emitEvent("LOG", { serverId: this.id, logs: [log] }));
    }

    listenLogs() {
        this.logsListener = new DockerLogsListener(this.container);
        this.logsListener.on("output", (output, date) => {
            this.log(output.replace(/\x1B[[(?);]{0,2}(;?\d)*./g, ""), date.getTime());
        });
        this.logsListener.listen();
    }

    async deploy() {
        this.state = "deploying";
        this.log("[raraph.fr] Deploying...");
        try {
            await this.container.stop({ t: 3 });
        } catch (error) {
        }
        this.lastLogs = [];
        const command = `${__dirname}/../deployNodeJs.sh ${this.name} ${this.githubRepo} ${this.githubAuth}`;
        exec(command).on("close", async () => {
            await this.container.start();
            console.log("Deployed " + this.githubRepo + " with command " + command);
        });
    }
}

module.exports = {
    Server,
    WebsiteServer,
    NodeJsServer
}

const prisma = require('../prisma/client');
const { deriverStatutTicket } = require('../utils/statut');

const LIGNE_ACTIVE = { transfere: false, escalade: false, retourne: false };

async function mettreAJourStatutTicket(tx, ticketId, technicienId, statutAffectation) {
  const statut = deriverStatutTicket(technicienId, statutAffectation);

  await tx.ticket.update({
    where: { id: ticketId },
    data: { statut },
  });
}

function estLigneActive(affectation) {
  return !affectation.transfere && !affectation.escalade && !affectation.retourne;
}

function aEteRecuParEscalade(affectation) {
  if (!affectation.affectationPrecedente) {
    return false;
  }
  return affectation.affectationPrecedente.escalade === true;
}

async function chargerAffectation(id) {
  return prisma.affectation.findUnique({
    where: { id: Number(id) },
    include: {
      ticket: true,
      technicien: true,
      affectationPrecedente: true,
      responsable: {
        include: {
          structure: { include: { niveau: true } },
        },
      },
    },
  });
}

async function assignerTechnicien(req, res) {
  const { technicienId } = req.body;

  if (!technicienId) {
    return res.status(400).json({ success: false, message: 'Le technicien est obligatoire.', errors: [] });
  }

  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  if (affectation.responsableId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Cette affectation ne vous appartient pas.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Vous n\'avez plus la main sur ce ticket.', errors: [] });
  }

  if (affectation.technicienId) {
    return res.status(409).json({ success: false, message: 'Un technicien est deja assigne, utilisez le transfert.', errors: [] });
  }

  const technicien = await prisma.technicien.findUnique({ where: { id: Number(technicienId) } });

  if (!technicien || technicien.responsableId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Ce technicien ne fait pas partie de votre equipe.', errors: [] });
  }

  if (!technicien.actif) {
    return res.status(409).json({ success: false, message: 'Ce technicien est desactive.', errors: [] });
  }

  const affectationMiseAJour = await prisma.$transaction(async (tx) => {
    const misAJour = await tx.affectation.update({
      where: { id: affectation.id },
      data: {
        technicienId: technicien.id,
        dateAffectation: new Date(),
        priorite: req.body.priorite || affectation.priorite,
      },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, technicien.id, misAJour.statut);

    return misAJour;
  });

  return res.status(200).json({ success: true, message: 'Technicien assigne.', data: affectationMiseAJour });
}

async function demarrer(req, res) {
  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  if (affectation.technicienId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Cette affectation ne vous appartient pas.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Vous n\'avez plus la main sur ce ticket.', errors: [] });
  }

  if (affectation.statut !== 'EN_ATTENTE') {
    return res.status(409).json({ success: false, message: 'Ce traitement a deja ete demarre.', errors: [] });
  }

  const affectationMiseAJour = await prisma.$transaction(async (tx) => {
    const misAJour = await tx.affectation.update({
      where: { id: affectation.id },
      data: { statut: 'EN_TRAITEMENT', dateDebutTrait: new Date() },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, affectation.technicienId, 'EN_TRAITEMENT');

    return misAJour;
  });

  return res.status(200).json({ success: true, message: 'Traitement demarre.', data: affectationMiseAJour });
}

async function cloturer(req, res) {
  const { commentaire } = req.body;

  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  if (affectation.technicienId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Cette affectation ne vous appartient pas.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Vous n\'avez plus la main sur ce ticket.', errors: [] });
  }

  if (affectation.statut !== 'EN_TRAITEMENT') {
    return res.status(409).json({ success: false, message: 'Le traitement doit etre demarre avant la cloture.', errors: [] });
  }

  const affectationMiseAJour = await prisma.$transaction(async (tx) => {
    const misAJour = await tx.affectation.update({
      where: { id: affectation.id },
      data: {
        statut: 'CLOTUREE',
        dateFinTrait: new Date(),
        commentaire: commentaire || affectation.commentaire,
      },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, affectation.technicienId, 'CLOTUREE');

    return misAJour;
  });

  return res.status(200).json({ success: true, message: 'Ticket cloture.', data: affectationMiseAJour });
}

async function transferer(req, res) {
  const { nouveauTechnicienId, raisonTransfert, commentaireTransfert } = req.body;

  if (!nouveauTechnicienId || !raisonTransfert) {
    return res.status(400).json({ success: false, message: 'Le nouveau technicien et la raison sont obligatoires.', errors: [] });
  }

  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  if (affectation.responsableId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Cette affectation ne releve pas de votre equipe.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Cette affectation a deja ete transferee, escaladee ou retournee.', errors: [] });
  }

  if (!affectation.technicienId) {
    return res.status(409).json({ success: false, message: 'Aucun technicien assigne, utilisez l\'assignation au lieu du transfert.', errors: [] });
  }

  if (affectation.statut === 'CLOTUREE') {
    return res.status(409).json({ success: false, message: 'Ce ticket est deja cloture.', errors: [] });
  }

  if (Number(nouveauTechnicienId) === affectation.technicienId) {
    return res.status(409).json({ success: false, message: 'Ce ticket est deja affecte a ce technicien.', errors: [] });
  }

  const nouveauTechnicien = await prisma.technicien.findUnique({ where: { id: Number(nouveauTechnicienId) } });

  if (!nouveauTechnicien || nouveauTechnicien.responsableId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Ce technicien ne fait pas partie de votre equipe.', errors: [] });
  }

  if (!nouveauTechnicien.actif) {
    return res.status(409).json({ success: false, message: 'Ce technicien est desactive.', errors: [] });
  }

  const nouvelleAffectation = await prisma.$transaction(async (tx) => {
    await tx.affectation.update({
      where: { id: affectation.id },
      data: {
        transfere: true,
        dateTransfert: new Date(),
        raisonTransfert,
        commentaireTransfert: commentaireTransfert || null,
      },
    });

    const creee = await tx.affectation.create({
      data: {
        ticketId: affectation.ticketId,
        responsableId: affectation.responsableId,
        technicienId: nouveauTechnicien.id,
        dateAffectation: new Date(),
        priorite: affectation.priorite,
        affectationPrecedenteId: affectation.id,
      },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, nouveauTechnicien.id, 'EN_ATTENTE');

    return creee;
  });

  return res.status(201).json({ success: true, message: 'Ticket transfere.', data: nouvelleAffectation });
}

async function escalader(req, res) {
  const { codeStructureCible, raisonEscalade, commentaireEscalade } = req.body;

  if (!codeStructureCible) {
    return res.status(400).json({ success: false, message: 'La structure cible est obligatoire.', errors: [] });
  }

  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  const estResponsableTitulaire = req.compte.typeCompte === 'RESPONSABLE' && affectation.responsableId === req.compte.id;
  const estTechnicienTitulaire = req.compte.typeCompte === 'TECHNICIEN' && affectation.technicienId === req.compte.id;

  if (!estResponsableTitulaire && !estTechnicienTitulaire) {
    return res.status(403).json({ success: false, message: 'Vous n\'avez pas la main sur ce ticket.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Cette affectation a deja ete transferee, escaladee ou retournee.', errors: [] });
  }

  if (affectation.statut === 'CLOTUREE') {
    return res.status(409).json({ success: false, message: 'Ce ticket est deja cloture.', errors: [] });
  }

  if (aEteRecuParEscalade(affectation)) {
    return res.status(409).json({
      success: false,
      message: 'Cette structure a recu ce ticket par escalade, elle ne peut pas l\'escalader plus haut.',
      errors: [],
    });
  }

  const structureCible = await prisma.structure.findUnique({
    where: { codeStructure: codeStructureCible },
    include: { niveau: true },
  });

  if (!structureCible) {
    return res.status(404).json({ success: false, message: 'Structure cible introuvable.', errors: [] });
  }

  const structureActuelle = affectation.responsable.structure;

  if (structureCible.id === structureActuelle.id) {
    return res.status(409).json({ success: false, message: 'La structure cible est la structure actuelle.', errors: [] });
  }

  if (structureCible.niveau.ordre >= structureActuelle.niveau.ordre) {
    return res.status(409).json({
      success: false,
      message: 'L\'escalade doit se faire vers une structure de niveau superieur.',
      errors: [],
    });
  }

  const responsableCible = await prisma.responsableEquipeTechnique.findUnique({
    where: { structureId: structureCible.id },
  });

  if (!responsableCible || !responsableCible.actif) {
    return res.status(409).json({
      success: false,
      message: 'Cette structure n\'a pas de responsable equipe technique actif.',
      errors: [],
    });
  }

  const nouvelleAffectation = await prisma.$transaction(async (tx) => {
    await tx.affectation.update({
      where: { id: affectation.id },
      data: {
        escalade: true,
        dateEscalade: new Date(),
        raisonEscalade: raisonEscalade || null,
        commentaireEscalade: commentaireEscalade || null,
      },
    });

    const creee = await tx.affectation.create({
      data: {
        ticketId: affectation.ticketId,
        responsableId: responsableCible.id,
        priorite: affectation.priorite,
        affectationPrecedenteId: affectation.id,
      },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, null, 'EN_ATTENTE');

    return creee;
  });

  return res.status(201).json({ success: true, message: 'Ticket escalade.', data: nouvelleAffectation });
}

async function retourner(req, res) {
  const { raisonRetour, commentaireRetour } = req.body;

  if (!raisonRetour) {
    return res.status(400).json({ success: false, message: 'La raison du retour est obligatoire.', errors: [] });
  }

  const affectation = await chargerAffectation(req.params.id);

  if (!affectation) {
    return res.status(404).json({ success: false, message: 'Affectation introuvable.', errors: [] });
  }

  if (affectation.responsableId !== req.compte.id) {
    return res.status(403).json({ success: false, message: 'Cette affectation ne vous appartient pas.', errors: [] });
  }

  if (!estLigneActive(affectation)) {
    return res.status(409).json({ success: false, message: 'Cette affectation a deja ete transferee, escaladee ou retournee.', errors: [] });
  }

  if (affectation.statut === 'CLOTUREE') {
    return res.status(409).json({ success: false, message: 'Ce ticket est deja cloture.', errors: [] });
  }

  if (!aEteRecuParEscalade(affectation)) {
    return res.status(409).json({
      success: false,
      message: 'Seul un ticket recu par escalade peut etre retourne a la structure d\'origine.',
      errors: [],
    });
  }

  const responsableOrigineId = affectation.affectationPrecedente.responsableId;

  const responsableOrigine = await prisma.responsableEquipeTechnique.findUnique({
    where: { id: responsableOrigineId },
  });

  if (!responsableOrigine || !responsableOrigine.actif) {
    return res.status(409).json({
      success: false,
      message: 'Le responsable de la structure d\'origine n\'est plus actif.',
      errors: [],
    });
  }

  const nouvelleAffectation = await prisma.$transaction(async (tx) => {
    await tx.affectation.update({
      where: { id: affectation.id },
      data: {
        retourne: true,
        dateRetour: new Date(),
        raisonRetour,
        commentaireRetour: commentaireRetour || null,
      },
    });

    const creee = await tx.affectation.create({
      data: {
        ticketId: affectation.ticketId,
        responsableId: responsableOrigine.id,
        priorite: affectation.priorite,
        affectationPrecedenteId: affectation.id,
      },
    });

    await mettreAJourStatutTicket(tx, affectation.ticketId, null, 'EN_ATTENTE');

    return creee;
  });

  return res.status(201).json({ success: true, message: 'Ticket retourne a la structure d\'origine.', data: nouvelleAffectation });
}

module.exports = { assignerTechnicien, demarrer, cloturer, transferer, escalader, retourner };